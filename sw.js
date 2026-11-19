// Paws & Plans: tiny service worker. Makes the app installable and loads it faster.
// Change VERSION whenever you upload a new index.html and want phones to refresh their saved copy.
const VERSION = 'v5';
const SHELL = 'paws-shell-' + VERSION;
const LIBS  = 'paws-libs-' + VERSION;
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => Promise.all(SHELL_FILES.map(f => c.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== LIBS && k !== 'paws-share').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only the app's own files plus the Firebase SDK and fonts are touched here.
// Everything else (sign-in, the live database) goes straight to the network.
const LIB_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // The phone's Share button sends files here: park them, then open the app
  if(req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')){
    e.respondWith(handleShare(req));
    return;
  }
  if(req.method !== 'GET') return;

  if(url.origin === self.location.origin){
    if(req.mode === 'navigate'){
      // Page: network first (so updates show up), saved copy if offline or slow.
      e.respondWith((async () => {
        const cache = await caches.open(SHELL);
        try{
          const res = await Promise.race([
            fetch(new Request(req.url, { cache:'no-cache', credentials:'same-origin' })),   // always check GitHub for a newer page
            new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))
          ]);
          if(res && res.ok) cache.put('./index.html', res.clone());
          return res;
        }catch(err){
          return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
        }
      })());
      return;
    }
    // Icons, manifest: saved copy right away, refreshed quietly in the background.
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      const fresh = fetch(req).then(res => { if(res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await fresh) || Response.error();
    })());
    return;
  }

  if(LIB_HOSTS.includes(url.hostname)){
    // Firebase SDK files are versioned and fonts rarely change: saved copy first.
    e.respondWith((async () => {
      const cache = await caches.open(LIBS);
      const hit = await cache.match(req);
      if(hit) return hit;
      try{
        const res = await fetch(req);
        if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }catch(err){
        return Response.error();
      }
    })());
  }
});

// Tapping a notification brings the app to the front.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});

async function handleShare(req){
  try{
    const fd = await req.formData();
    const cache = await caches.open('paws-share');
    for(const k of await cache.keys()) await cache.delete(k);
    const files = fd.getAll('files').filter(f => f && typeof f !== 'string');
    let i = 0;
    for(const f of files){
      await cache.put('./shared/' + (i++), new Response(f, { headers:{ 'X-Name': encodeURIComponent(f.name || 'file'), 'Content-Type': f.type || 'application/octet-stream' } }));
    }
    const text = ['title', 'text', 'url'].map(k => fd.get(k)).filter(x => typeof x === 'string' && x).join('\n');
    await cache.put('./shared/meta', new Response(JSON.stringify({ count: files.length, text }), { headers:{ 'Content-Type':'application/json' } }));
  }catch(err){}
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}
