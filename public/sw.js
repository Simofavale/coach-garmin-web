// Service worker (come Rassegna): si va sempre in rete; la copia salvata serve solo quando la rete manca,
// così l'app si apre anche offline con gli ultimi dati scaricati.
const CACHE = 'coachgarmin-v1';
const BASE = new URL('./', self.location).pathname;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  const p = u.pathname.slice(BASE.length);
  const isPage = req.mode === 'navigate', isData = p === 'api/garmin.json', isCode = /\.(js|css|webmanifest)$/.test(p);
  if (!isPage && !isData && !isCode) return;
  const key = isPage ? BASE : (isData ? BASE + p : u.origin + u.pathname);
  const net = fetch(new Request(u.href, { cache: 'no-cache', credentials: 'same-origin' }));
  e.respondWith(net.then(r => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); }
    return r;
  }).catch(() => caches.match(key).then(r => r || Response.error())));
});
