/* डेरी हिसाब — अफलाइन Service Worker
   काम: एपको फाइल (HTML) फोनमा क्यास गरेर इन्टरनेट नभए पनि एप खोल्न दिने।
   डेटा (ग्राहक, अर्डर, हिसाब) IndexedDB/localStorage मा छ — यो फाइलले त्यसलाई कहिल्यै छुँदैन।
   क्लाउड सिङ्क (अर्को साइटको अनुरोध) लाई पनि छुँदैन — ती सिधै इन्टरनेटमै जान्छन्।
   यो फाइल index.html कै फोल्डरमा, उही नामले "sw.js" राख्नुपर्छ। */
const V = 'dairy-hisab-v1';
const PREFIX = 'dairy-hisab-';
const SCOPE = self.registration.scope;
const CORE = [SCOPE, SCOPE + 'index.html'];
const MK = SCOPE + '__upd';   /* "नयाँ संस्करण आयो" को चिह्न */

const keyOf = (u) => { const x = new URL(u); x.hash = ''; x.search = ''; return x.href; };

/* redirect भएको response नेभिगेसनमा चल्दैन — सफा प्रतिलिपि बनाउने */
async function clean(res) {
  if (!res.redirected) return res;
  const b = await res.blob();
  return new Response(b, { status: 200, statusText: 'OK', headers: res.headers });
}

async function tell(msg) {
  const cs = await self.clients.matchAll({ includeUncontrolled: true });
  cs.forEach((c) => { try { c.postMessage(msg); } catch (e) {} });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.all(CORE.map(async (u) => {
      try {
        const r = await fetch(u, { cache: 'reload' });
        if (r && r.ok && r.type === 'basic') await c.put(u, await clean(r));
      } catch (err) { /* एउटा फाइल नभेटिए बाँकीलाई नरोक्ने */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    let hadOld = false;
    for (const k of await caches.keys()) {
      if (k.indexOf(PREFIX) === 0 && k !== V) { hadOld = true; await caches.delete(k); }
    }
    await self.clients.claim();
    if (hadOld) tell({ t: 'sw-upd' });
  })());
});

self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.t === 'skip') self.skipWaiting();
  if (e.data.t === 'off') self.__off = true;
  if (e.data.t === 'chk') {
    /* पेज खुलेपछि सोध्छ: क्यासमा यसभन्दा नयाँ संस्करण आइसकेको छ? */
    const src = e.source;
    e.waitUntil((async () => {
      if (self.__off || !(await caches.has(V))) return;
      const c = await caches.open(V);
      if (await c.match(MK)) { try { src.postMessage({ t: 'sw-upd' }); } catch (err) {} }
    })());
  }
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (self.__off) return;                  /* बन्द गर्न भनिएपछि सबै अनुरोध सिधै इन्टरनेटमा */
  if (r.method !== 'GET') return;
  if (r.headers.get('range')) return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;        /* अर्को साइट (Supabase आदि) — नछुने */
  if (u.pathname.endsWith('/sw.js')) return;            /* SW आफ्नै फाइल — ब्राउजरले सिधै जाँच्छ */

  if (r.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(V);
      const k = keyOf(r.url);
      const was = await c.match(MK);      /* अघिल्लो पटक नयाँ आएको थियो भने अब त्यही सेवा हुँदैछ */
      if (was) await c.delete(MK);
      const hit = (await c.match(k)) || (await c.match(SCOPE)) || (await c.match(SCOPE + 'index.html'));
      const oldCopy = hit ? hit.clone() : null;   /* hit पठाइसकेपछि पढ्न मिल्दैन — अगावै प्रतिलिपि */
      const upd = fetch(r.url, { cache: 'no-cache' }).then(async (res) => {
        if (res && res.ok && res.type === 'basic') {
          const fresh = await clean(res);
          let changed = false;
          if (oldCopy) {
            try { changed = (await oldCopy.text()) !== (await fresh.clone().text()); } catch (err) {}
          }
          await c.put(k, fresh.clone());
          if (changed) { await c.put(MK, new Response('1')); tell({ t: 'sw-upd' }); }
          return fresh;
        }
        return null;
      }).catch(() => null);
      if (hit) { e.waitUntil(upd); return hit; }
      const net = await upd;
      if (net) return net;
      return new Response('अफलाइन — एप अहिलेसम्म यो फोनमा सुरक्षित भएको छैन। एकपटक इन्टरनेट खोलेर यो पेज खोल्नुहोस्।',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }

  /* अन्य एउटै साइटका फाइल (आइकन, manifest आदि): क्यासबाट दिने, पछाडि नयाँ तान्ने */
  e.respondWith((async () => {
    const c = await caches.open(V);
    const hit = await c.match(r);
    const upd = fetch(r).then(async (res) => {
      if (res && res.ok && res.type === 'basic') await c.put(r, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(upd); return hit; }
    return (await upd) || new Response('', { status: 504 });
  })());
});
