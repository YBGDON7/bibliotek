/* =====================================================================
   Lärandemålsbiblioteket – service worker
   Gör tre saker:
   1. Sparar appen (index.html) i webbläsarens cache, så att den startar
      direkt och fungerar utan nät.
   2. Hämtar en ny version i bakgrunden när appen ber om det, och säger
      till när den är klar. Sidan laddas aldrig om av sig själv.
   3. Sparar typsnitt och de bibliotek som hämtas utifrån (Firebase,
      textigenkänning), så att även de finns utan nät.
   version.json går alltid till nätet – det är den som avslöjar nya byggen.
   ===================================================================== */
const SIDCACHE = "bib-sida-v1";
const CDNCACHE = "bib-cdn-v1";
const SKAL = self.registration.scope;                 // t.ex. https://…/bibliotek/
const META = SKAL + "__meta";
const CDN = /^https:\/\/(www\.gstatic\.com\/firebasejs\/|fonts\.googleapis\.com\/|fonts\.gstatic\.com\/|cdn\.jsdelivr\.net\/|cdnjs\.cloudflare\.com\/|unpkg\.com\/|tessdata\.projectnaptha\.com\/)/;

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const namn = await caches.keys();
    await Promise.all(namn.filter(n => n.startsWith("bib-") && n !== SIDCACHE && n !== CDNCACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function arSidan(url) {
  if (url.origin !== location.origin) return false;
  const ren = url.origin + url.pathname;
  return ren === SKAL || ren === SKAL + "index.html";
}

async function lasMeta() {
  try {
    const c = await caches.open(SIDCACHE);
    const m = await c.match(META);
    return m ? await m.json() : {};
  } catch (e) { return {}; }
}
async function skrivMeta(meta) {
  const c = await caches.open(SIDCACHE);
  await c.put(META, new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
}

/* Läser byggets id ur filens första rader (<meta name="bygg" …>) utan att
   läsa in hela filen i minnet. */
async function lasByggId(strom) {
  const lasare = strom.getReader();
  const avkodare = new TextDecoder();
  let text = "";
  try {
    while (text.length < 4096) {
      const { value, done } = await lasare.read();
      if (done) break;
      text += avkodare.decode(value, { stream: true });
    }
  } finally {
    /* Inte await: en delad ström svarar på cancel först när båda grenarna är klara. */
    try { lasare.cancel().catch(() => {}); } catch (e) {}
  }
  const m = text.match(/<meta name="bygg" content="([^"]+)"/);
  return m ? m[1] : "";
}

/* Hämtar sidan och lägger den i cachen. kravBygg: lagra bara om filen
   verkligen är det bygget (annars har servern inte hunnit med ännu). */
async function hamtaOchSpara(adress, cacheLage, kravBygg) {
  const svar = await fetch(adress, { cache: cacheLage, credentials: "same-origin" });
  if (!svar.ok || svar.status !== 200 || !svar.body) throw new Error("status " + svar.status);
  const [forId, forCache] = svar.body.tee();
  const huvud = new Headers(svar.headers);
  huvud.delete("content-encoding"); huvud.delete("content-length");
  if (!huvud.get("content-type")) huvud.set("content-type", "text/html; charset=utf-8");
  const c = await caches.open(SIDCACHE);
  const idLofte = lasByggId(forId);
  if (kravBygg) {
    const id = await idLofte;
    if (id !== kravBygg) { try { await forCache.cancel(); } catch (e) {} throw new Error("gammal"); }
    await c.put(SKAL, new Response(forCache, { status: 200, headers: huvud }));
    await skrivMeta({ bygg: id, nar: Date.now() });
    return id;
  }
  const [, id] = await Promise.all([c.put(SKAL, new Response(forCache, { status: 200, headers: huvud })), idLofte]);
  await skrivMeta({ bygg: id, nar: Date.now() });
  return id;
}

let _pagar = null;        // { bygg, lofte } – en hämtning åt gången
function hamtaNy(bygg) {
  if (_pagar && _pagar.bygg === bygg) return _pagar.lofte;
  const lofte = (async () => {
    const meta = await lasMeta();
    if (meta.bygg === bygg) return bygg;
    return hamtaOchSpara(SKAL + "?v=" + encodeURIComponent(bygg), "reload", bygg);
  })();
  _pagar = { bygg, lofte };
  lofte.then(() => { if (_pagar && _pagar.lofte === lofte) _pagar = null; }, () => { if (_pagar && _pagar.lofte === lofte) _pagar = null; });
  return lofte;
}

async function tillAlla(medd) {
  const alla = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  alla.forEach(k => { try { k.postMessage(medd); } catch (e) {} });
}

self.addEventListener("message", e => {
  const d = e.data || {};
  const svara = medd => { try { e.source.postMessage(medd); } catch (err) {} };
  if (d.typ === "spara") {
    e.waitUntil((async () => {
      try {
        const c = await caches.open(SIDCACHE);
        if (await c.match(SKAL, { ignoreVary: true })) { svara({ typ: "sparad", bygg: (await lasMeta()).bygg || "" }); return; }
        const id = await hamtaOchSpara(SKAL, "force-cache", "");
        svara({ typ: "sparad", bygg: id });
      } catch (err) { svara({ typ: "sparfel", fel: String(err && err.message || err) }); }
    })());
  } else if (d.typ === "hamta" && d.bygg) {
    e.waitUntil(hamtaNy(String(d.bygg)).then(
      id => tillAlla({ typ: "klar", bygg: id }),
      err => svara({ typ: "fel", bygg: d.bygg, fel: String(err && err.message || err) })));
  } else if (d.typ === "status") {
    e.waitUntil(lasMeta().then(m => svara({ typ: "status", bygg: m.bygg || "" })));
  }
});

async function sidan(e) {
  const c = await caches.open(SIDCACHE);
  const traff = await c.match(SKAL, { ignoreVary: true });
  if (traff) return traff;
  return fetch(e.request);
}

/* Visa det sparade direkt och fräscha upp i bakgrunden. */
async function sparatForst(e, namn) {
  const c = await caches.open(namn);
  const traff = await c.match(e.request, { ignoreVary: true });
  const nat = fetch(e.request).then(s => {
    if (s && (s.ok || s.type === "opaque")) c.put(e.request, s.clone()).catch(() => {});
    return s;
  }).catch(() => null);
  if (traff) { e.waitUntil(nat); return traff; }
  const s = await nat;
  return s || new Response("", { status: 504, statusText: "Offline" });
}

/* Klick på en notis: lyft fram appen och gå till rätt sida. */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "#/";
  e.waitUntil((async () => {
    const alla = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const k = alla.find(c => c.url.indexOf(SKAL) === 0);
    if (k) { try { await k.focus(); } catch (err) {} k.postMessage({ typ: "ga", url }); }
    else await self.clients.openWindow(SKAL + url);
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (arSidan(url)) { e.respondWith(sidan(e)); return; }
  if (url.origin === location.origin) {
    if (!url.href.startsWith(SKAL)) return;
    if (/\/version\.json$/.test(url.pathname) || /\/sw\.js$/.test(url.pathname)) return;
    e.respondWith(sparatForst(e, SIDCACHE));
    return;
  }
  if (CDN.test(url.href)) e.respondWith(sparatForst(e, CDNCACHE));
});
