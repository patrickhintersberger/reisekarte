// Macht die Reisekarte offline nutzbar (z.B. im Flugzeug).
// - Die App samt Bibliotheken und Schriften wird beim Installieren auf dem Gerät abgelegt.
// - Eigene Dateien kommen zuerst aus dem Netz (Updates kommen sofort an), aber nur, wenn das Netz schnell antwortet.
// - Kartendaten (OpenFreeMap): Stil, Symbole und Schriften werden mitgespeichert. Die Weltkarte bis Zoomstufe 5
//   lädt die App einmal herunter (offline.js); diese Kacheln kommen dann immer aus dem Speicher.
const CACHE = 'reisekarte-v13';
const MAP_CACHE = 'reisekarte-weltkarte'; // bleibt bei App-Updates erhalten
const LIBS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const SHELL = ['index.html', 'app.js', 'sync.js', 'config.js', 'offline.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png'];
const NET_WAIT = 3000;

function ownKey(url) {
  const u = new URL(url, location.href);
  let path = u.pathname;
  if (path.endsWith('/')) path += 'index.html';
  return u.origin + path;
}
// Kacheln ohne Versionsangabe ablegen (OpenFreeMap wechselt die Version wöchentlich): …/planet/<Version>/z/x/y.pbf -> ofm/planet/z/x/y
function tileKey(url) {
  const u = new URL(url);
  let m = u.pathname.match(/^\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (m) return { key: `https://tiles.openfreemap.org/ofm/planet/${m[1]}/${m[2]}/${m[3]}`, z: +m[1] };
  m = u.pathname.match(/^\/natural_earth\/ne2sr\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (m) return { key: u.origin + u.pathname, z: +m[1] };
  return null;
}

self.addEventListener('install', e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async f => {
    const res = await fetch(f, { cache: 'no-cache' });
    if (!res.ok) throw new Error(f);
    await cache.put(ownKey(f), res);
  }));
  const html = await (await cache.match(ownKey('index.html'))).text();
  const urls = [...html.matchAll(/(?:href|src)="(https:\/\/[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
    .filter(u => LIBS.includes(new URL(u).hostname));
  await Promise.allSettled(urls.map(async u => {
    const res = await fetch(u, { mode: 'cors' });
    if (!res.ok) return;
    if (new URL(u).hostname === 'fonts.googleapis.com') {
      const css = await res.clone().text();
      const fonts = [...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]);
      await Promise.allSettled(fonts.map(async f => { const r = await fetch(f, { mode: 'cors' }); if (r.ok) await cache.put(f, r); }));
    }
    await cache.put(u, res);
  }));
  self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('reisekarte-v') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith(new URL(self.registration.scope).pathname)) e.respondWith(fromOwn(req));
    return;
  }
  if (url.searchParams.has('online-check')) return; // Prüfung, ob wieder Internet da ist: immer direkt ins Netz
  if (url.hostname === 'tiles.openfreemap.org') return e.respondWith(fromMap(req, url));
  if (LIBS.includes(url.hostname)) return e.respondWith(fromLib(req));
  // GitHub-API, Satellitenbilder, Ortssuche: nicht zwischenspeichern
});

async function fromLib(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function fromOwn(req) {
  const cache = await caches.open(CACHE);
  const key = ownKey(req.url);
  // Beim Server nachfragen statt den Browser-Zwischenspeicher zu nehmen (GitHub Pages erlaubt dort 10 Minuten),
  // sonst kommt ein Update erst verspätet an. Unverändertes wird mit „nicht geändert“ beantwortet und kostet kaum etwas.
  const net = fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' }).then(res => { if (res.ok) cache.put(key, res.clone()); return res; });
  let hit = await cache.match(key);
  if (!hit && req.mode === 'navigate') hit = await cache.match(ownKey('index.html'));
  if (!hit) return net;
  const res = await Promise.race([net.catch(() => null), new Promise(r => setTimeout(() => r(null), NET_WAIT))]);
  return res && res.ok ? res : hit;
}

// Netzabfrage mit Zeitlimit, damit ein hängendes WLAN die Karte nicht blockiert
function fetchWait(req, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(req, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

async function fromMap(req, url) {
  const cache = await caches.open(MAP_CACHE);
  const tile = tileKey(req.url);
  if (tile) {
    // Gespeicherte Weltkarte zuerst; feinere Kacheln aus dem Netz (nicht speichern, sonst wächst der Speicher endlos)
    const hit = await cache.match(tile.key);
    if (hit) return hit;
    return fetchWait(req, 10000);
  }
  // Schriften und Symbole ändern sich nie: aus dem Speicher, sonst holen und ablegen
  const key = url.origin + url.pathname;
  if (/^\/(fonts|sprites)\//.test(url.pathname)) {
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = await fetchWait(req, 10000);
    if (res.ok) cache.put(key, res.clone());
    return res;
  }
  // Kartenstil und Kachel-Verzeichnis: zuerst Netz (kurz), sonst gespeicherte Fassung
  const hit = await cache.match(key);
  try {
    const res = await fetchWait(req, hit ? NET_WAIT : 15000);
    if (res.ok) cache.put(key, res.clone());
    return res.ok || !hit ? res : hit;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}
