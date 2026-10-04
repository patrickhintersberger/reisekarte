// Offline-Weltkarte: lädt einmal die ganze Welt bis Zoomstufe 5 (Länder, Regionen, größere Städte und Straßen)
// von OpenFreeMap in den Speicher des Geräts, ähnlich der Übersichtskarte von Maps.me.
// Die Kacheln werden ohne Versionsangabe abgelegt, genau so, wie sw.js sie wieder heraussucht.
(function () {
  const MAP_CACHE = 'reisekarte-weltkarte';
  const OFM = 'https://tiles.openfreemap.org';
  const VEC_Z = 5;    // Vektorkarte bis Zoomstufe 5 (ca. 110 MB auf dem Gerät)
  const RELIEF_Z = 3; // Geländeschattierung bis Zoomstufe 3 (ca. 9 MB)
  const GLYPHS = ['0-255', '256-511', '512-767', '7680-7935', '8192-8447']; // lateinische Schrift inkl. Sonderzeichen
  const LS = 'rk-weltkarte';
  const WORKERS = 6;

  const st = { done: 0, total: 0, running: false, complete: false, error: '' };
  try { st.complete = localStorage.getItem(LS) === '1'; } catch {}
  const listeners = new Set();
  let lastEmit = 0;
  function emit(force) {
    const now = Date.now();
    if (!force && now - lastEmit < 400) return;
    lastEmit = now;
    listeners.forEach(fn => { try { fn(); } catch {} });
  }

  async function jobs() {
    const tj = await (await fetch(`${OFM}/planet`, { cache: 'no-store' })).json();
    const tpl = tj.tiles[0];
    const list = [];
    for (let z = 0; z <= VEC_Z; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++)
      list.push({ url: tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), key: `${OFM}/ofm/planet/${z}/${x}/${y}` });
    for (let z = 0; z <= RELIEF_Z; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
      const url = `${OFM}/natural_earth/ne2sr/${z}/${x}/${y}.png`;
      list.push({ url, key: url });
    }
    // Stile, Symbole und Schriften, die die beiden Kartenstile brauchen
    const stacks = new Set(), sprites = new Set();
    for (const name of ['liberty', 'dark']) {
      const url = `${OFM}/styles/${name}`;
      list.push({ url, key: url });
      const s = await (await fetch(url)).json();
      if (typeof s.sprite === 'string') sprites.add(s.sprite);
      s.layers.forEach(l => { const f = l.layout && l.layout['text-font']; if (Array.isArray(f) && f.every(x => typeof x === 'string')) stacks.add(f.join(',')); });
    }
    list.push({ url: `${OFM}/planet`, key: `${OFM}/planet` });
    sprites.forEach(sp => ['.json', '.png', '@2x.json', '@2x.png'].forEach(ext => list.push({ url: sp + ext, key: new URL(sp + ext).href })));
    stacks.forEach(stack => GLYPHS.forEach(r => {
      const u = new URL(`${OFM}/fonts/${encodeURIComponent(stack)}/${r}.pbf`);
      list.push({ url: u.href, key: u.origin + u.pathname });
    }));
    return list;
  }

  async function start() {
    if (st.running || !('caches' in window) || !navigator.onLine) return;
    st.running = true; st.error = ''; emit(true);
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const list = await jobs();
      const cache = await caches.open(MAP_CACHE);
      st.total = list.length; st.done = 0;
      let i = 0, failed = 0;
      const work = async () => {
        while (i < list.length) {
          const j = list[i++];
          if (!(await cache.match(j.key))) {
            try {
              const res = await fetch(j.url);
              if (res.ok) await cache.put(j.key, res); else failed++;
            } catch { failed++; if (!navigator.onLine) throw new Error('offline'); }
          }
          st.done++; emit();
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, work));
      st.complete = failed === 0;
      if (st.complete) try { localStorage.setItem(LS, '1'); } catch {}
      else st.error = `${failed} Kartenteile fehlen noch, sie werden beim nächsten Start nachgeladen.`;
    } catch (e) {
      st.error = 'Download unterbrochen, er geht weiter, sobald wieder Internet da ist.';
    } finally {
      st.running = false; emit(true);
    }
  }

  // Automatisch laden, außer bei bekannter Mobilfunk- oder Datensparverbindung
  function auto() {
    if (st.complete) return;
    const c = navigator.connection;
    if (c && (c.saveData || c.type === 'cellular')) return;
    start();
  }
  window.addEventListener('online', () => setTimeout(auto, 3000));
  setTimeout(auto, 4000);

  window.RK_OFFLINE = {
    get state() { return { ...st }; },
    start,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
