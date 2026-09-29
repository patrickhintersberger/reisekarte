/* Reisekarte – Hauptlogik */
(function () {
  'use strict';
  const S = window.RK_STORE;
  const CATS = window.RK_CATEGORIES;
  const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
  // Priorität nach Pareto: die wenigen Orte, die den Großteil des Erlebnisses ausmachen, zuerst
  const PRIO = {
    1: { stars: '★★★', label: 'Must-see', hint: 'Einer der Höhepunkte, unbedingt einplanen' },
    2: { stars: '★★', label: 'Lohnt sich', hint: 'Schön, wenn Zeit ist' },
    3: { stars: '★', label: 'Optional', hint: 'Nur bei Interesse oder wenn es auf dem Weg liegt' },
  };
  const TRIP_COLORS = ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#12b5cb', '#e52592', '#f9ab00', '#5f6368', '#795548'];
  const regionNames = (() => { try { return new Intl.DisplayNames(['de'], { type: 'region' }); } catch { return null; } })();
  const $ = sel => document.querySelector(sel);
  const app = $('#app');
  const sheet = $('#sheet');
  const body = $('#sheet-body');
  const isDesktop = () => window.matchMedia('(min-width: 820px)').matches;

  // ---------- Hilfsfunktionen ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const cat = id => CAT[id] || CAT.sonstiges;
  function flag(cc) {
    if (!cc || !/^[a-z]{2}$/i.test(cc)) return '🏳️';
    return String.fromCodePoint(...cc.toUpperCase().split('').map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
  }
  function countryName(cc) {
    if (!cc) return 'Unbekanntes Land';
    try { return (regionNames && regionNames.of(cc.toUpperCase())) || cc.toUpperCase(); } catch { return cc.toUpperCase(); }
  }
  const hasPos = p => typeof p.lat === 'number' && typeof p.lng === 'number';
  const fmtDate = d => d ? new Date(d).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const today = () => new Date().toISOString().slice(0, 10);
  function guessCategory(name, osmKey, osmValue) {
    const M = window.RK_OSM_MAP;
    for (const [id, re] of window.RK_KEYWORDS) if (re.test(name || '')) return id;
    if (osmKey && (M[`${osmKey}:${osmValue}`] || M[`${osmKey}:*`])) return M[`${osmKey}:${osmValue}`] || M[`${osmKey}:*`];
    return 'sonstiges';
  }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- Zustand der Oberfläche ----------
  const ui = {
    tab: lsGet('rk-tab', 'countries'),        // countries | trips | all
    status: lsGet('rk-status', 'all'),        // all | open | done
    sort: lsGet('rk-sort', 'name'),
    cats: new Set(lsGet('rk-cats', [])),      // aktive Kategorie-Filter (leer = alle)
    activeTrip: null,
    expanded: new Set(),
    stack: [],                                 // Ansichten-Verlauf
    selected: null,
    placing: null,                             // { id } beim Platzieren eines Punkts
  };

  // ---------- Karte ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true, tap: false, minZoom: 2, maxZoom: 19 })
    .setView(lsGet('rk-view', [48.5, 11]).slice(0, 2), lsGet('rk-view', [48.5, 11, 5])[2] || 5);
  if (isDesktop()) L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.on('moveend', () => { const c = map.getCenter(); lsSet('rk-view', [c.lat, c.lng, map.getZoom()]); });

  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const attrOSM = 'Suche: <a href="https://www.geoapify.com" target="_blank" rel="noopener">Powered by Geoapify</a> · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  // Vektorkarte (OpenFreeMap) mit deutschen Beschriftungen
  function vectorLayer(style) {
    const layer = L.maplibreGL({ style: `https://tiles.openfreemap.org/styles/${style}`, attribution: attrOSM });
    layer.once('add', () => {
      const gl = layer.getMaplibreMap();
      gl.on('styledata', function germanLabels() {
        gl.off('styledata', germanLabels);
        gl.getStyle().layers.forEach(l => {
          if (l.type === 'symbol' && l.layout && l.layout['text-field']) {
            try { gl.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name:latin'], ['get', 'name']]); } catch {}
          }
        });
      });
    });
    return layer;
  }
  const layers = {
    light: vectorLayer('liberty'),
    dark: vectorLayer('dark'),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Bilder &copy; Esri' }),
    labels: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, pane: 'overlayPane' }),
  };
  let baseMode = lsGet('rk-base', 'map');
  function applyBase() {
    Object.values(layers).forEach(l => map.removeLayer(l));
    if (baseMode === 'sat') { layers.sat.addTo(map); layers.labels.addTo(map); }
    else (dark.matches ? layers.dark : layers.light).addTo(map);
    $('#layer-btn').classList.toggle('active', baseMode === 'sat');
    $('#layer-btn').setAttribute('aria-label', baseMode === 'sat' ? 'Zur Kartenansicht wechseln' : 'Zur Satellitenansicht wechseln');
  }
  dark.addEventListener?.('change', applyBase);
  $('#layer-btn').onclick = () => { baseMode = baseMode === 'sat' ? 'map' : 'sat'; lsSet('rk-base', baseMode); applyBase(); };
  applyBase();

  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false, zoomToBoundsOnClick: false, spiderfyOnMaxZoom: false,
    maxClusterRadius: z => (z < 6 ? 56 : z < 12 ? 48 : 36), chunkedLoading: true,
    iconCreateFunction(c) {
      const ms = c.getAllChildMarkers();
      const allDone = ms.every(m => m.options.done);
      const n = c.getChildCount();
      return L.divIcon({ html: `<div class="cl${n >= 100 ? ' big' : ''}${allDone ? ' alldone' : ''}">${n}</div>`, className: 'rk-cluster', iconSize: [50, 50] });
    },
  });
  map.addLayer(cluster);
  cluster.on('clusterclick', e => {
    const ids = e.layer.getAllChildMarkers().map(m => m.options.placeId);
    openView({ name: 'cluster', ids, bounds: e.layer.getBounds() });
  });

  const iconCache = new Map();
  function placeIcon(p, selected) {
    const c = cat(p.category);
    const key = `${c.id}|${p.visited ? 1 : 0}|${p.country || ''}|${selected ? 1 : 0}`;
    if (iconCache.has(key)) return iconCache.get(key);
    const badge = p.visited ? '✅' : flag(p.country);
    const icon = L.divIcon({
      className: 'rk-marker',
      html: `<div class="pin-wrap${p.visited ? ' done' : ''}${selected ? ' sel' : ''}" style="--c:${c.color}"><div class="pin"><span class="ms">${c.icon}</span></div><span class="pin-badge">${badge}</span></div>`,
      iconSize: [34, 34], iconAnchor: [17, 42],
    });
    iconCache.set(key, icon);
    return icon;
  }

  const markers = new Map(); // id -> marker
  function visiblePlaces() {
    return S.places.filter(p => {
      if (!hasPos(p)) return false;
      if (ui.cats.size && !ui.cats.has(cat(p.category).id)) return false;
      if (ui.status === 'open' && p.visited) return false;
      if (ui.status === 'done' && !p.visited) return false;
      if (ui.activeTrip && !(p.tripIds || []).includes(ui.activeTrip)) return false;
      return true;
    });
  }
  function renderMarkers() {
    const list = visiblePlaces();
    const want = new Set(list.map(p => p.id));
    for (const [id, m] of markers) if (!want.has(id)) { cluster.removeLayer(m); markers.delete(id); }
    const add = [];
    for (const p of list) {
      const sel = ui.selected === p.id;
      let m = markers.get(p.id);
      const sig = `${p.lat},${p.lng},${p.category},${p.visited},${p.country},${sel}`;
      if (m && m.options.sig === sig) continue;
      if (m) { cluster.removeLayer(m); markers.delete(p.id); }
      m = L.marker([p.lat, p.lng], { icon: placeIcon(p, sel), placeId: p.id, done: !!p.visited, sig, zIndexOffset: sel ? 1000 : 0, keyboard: true, title: p.name });
      m.on('click', () => openPlace(p.id, true));
      markers.set(p.id, m);
      add.push(m);
    }
    if (add.length) cluster.addLayers(add);
  }

  // Punkt so zentrieren, dass er nicht unter Sheet/Seitenleiste liegt
  function focusOn(lat, lng, zoom) {
    const z = zoom ?? Math.max(map.getZoom(), 14);
    const pt = map.project([lat, lng], z);
    if (isDesktop()) pt.x -= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-w')) / 2 || 204;
    else pt.y += (sheetHeight() - 60) / 2 - 40;
    map.flyTo(map.unproject(pt, z), z, { duration: .6 });
  }
  function fitPlaces(list) {
    const pts = list.filter(hasPos).map(p => [p.lat, p.lng]);
    if (!pts.length) return;
    if (pts.length === 1) return focusOn(pts[0][0], pts[0][1], 14);
    const opts = isDesktop()
      ? { paddingTopLeft: [430, 80], paddingBottomRight: [60, 40], maxZoom: 15 }
      : { paddingTopLeft: [30, 120], paddingBottomRight: [30, sheetHeight() + 20], maxZoom: 15 };
    const size = map.getSize();
    const padX = (opts.paddingTopLeft[0] + opts.paddingBottomRight[0]), padY = (opts.paddingTopLeft[1] + opts.paddingBottomRight[1]);
    // Bei sehr kleinem Kartenfenster wäre der Rand größer als die Karte -> ohne Rand einpassen
    const safe = size.x - padX > 80 && size.y - padY > 80 ? opts : { maxZoom: 15 };
    try { map.flyToBounds(L.latLngBounds(pts), { ...safe, duration: .6 }); }
    catch { try { map.fitBounds(L.latLngBounds(pts), { maxZoom: 15 }); } catch {} }
  }

  // temporärer Marker (Suchergebnis / neuer Punkt)
  let tempMarker = null;
  function setTemp(lat, lng) {
    clearTemp();
    tempMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'rk-marker temp-pin', html: '<div class="pin-wrap sel"><div class="pin"><span class="ms">place</span></div></div>', iconSize: [34, 34], iconAnchor: [17, 42] }),
      zIndexOffset: 2000,
    }).addTo(map);
  }
  function clearTemp() { if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; } }

  // ---------- Standort ----------
  let meMarker = null, lastPos = null;
  function locate(fly = true) {
    return new Promise(resolve => {
      if (!navigator.geolocation) { toast('Standort ist auf diesem Gerät nicht verfügbar.'); return resolve(null); }
      navigator.geolocation.getCurrentPosition(pos => {
        lastPos = [pos.coords.latitude, pos.coords.longitude];
        if (!meMarker) meMarker = L.marker(lastPos, { icon: L.divIcon({ className: 'rk-marker', html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 3000 }).addTo(map);
        else meMarker.setLatLng(lastPos);
        $('#locate-btn').classList.add('active');
        if (fly) focusOn(lastPos[0], lastPos[1], Math.max(map.getZoom(), 13));
        resolve(lastPos);
      }, () => { if (fly) toast('Standort nicht freigegeben.'); resolve(null); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }
  $('#locate-btn').onclick = () => locate(true);

  // ---------- Geodienste (OpenStreetMap) ----------
  async function reverse(lat, lng) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=de`);
      if (!r.ok) return null;
      const j = await r.json();
      const a = j.address || {};
      return {
        country: (a.country_code || '').toLowerCase() || null,
        name: j.name || a.tourism || a.amenity || a.road || a.village || a.town || a.city || '',
        address: j.display_name || '',
        city: a.city || a.town || a.village || a.municipality || '',
        category: guessCategory(j.name, j.category, j.type),
      };
    } catch { return null; }
  }
  const searchCache = new Map();
  // Schnelle Suche beim Abschicken (Enter / „Suchen“). Nominatim erlaubt keine Suche bei jedem Tastendruck.
  let lastNominatim = 0;
  async function nominatimSearch(q) {
    const key = 'n|' + norm(q);
    if (searchCache.has(key)) return searchCache.get(key);
    const wait = lastNominatim + 1000 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatim = Date.now();
    const vb = map.getBounds().pad(2);
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&accept-language=de&q=${encodeURIComponent(q)}&viewbox=${vb.getWest()},${vb.getNorth()},${vb.getEast()},${vb.getSouth()}`;
    const j = await (await fetch(url)).json();
    const out = (j || []).map(x => {
      const a = x.address || {};
      const place = a.city || a.town || a.village || a.municipality || a.county;
      const bb = x.boundingbox ? x.boundingbox.map(Number) : null; // [S, N, W, E]
      return {
        name: x.name || (x.display_name || '').split(',')[0] || q,
        sub: [place, a.state, a.country].filter(Boolean).filter(s => s !== x.name).join(', '),
        lat: +x.lat, lng: +x.lon,
        country: (a.country_code || '').toLowerCase() || null,
        extent: bb ? [bb[2], bb[1], bb[3], bb[0]] : null, // [W, N, E, S] wie bei Photon
        category: guessCategory(x.name, x.category, x.type),
        address: x.display_name || '',
      };
    });
    searchCache.set(key, out);
    return out;
  }
  // Vorschläge beim Tippen. Anfragen laufen parallel weiter (kein Abbrechen), damit
  // Ergebnisse für den bisher getippten Anfang schon erscheinen, während man weitertippt.
  const photonPending = new Map();
  function photon(q) {
    const key = 'p|' + norm(q);
    if (searchCache.has(key)) return Promise.resolve(searchCache.get(key));
    if (photonPending.has(key)) return photonPending.get(key);
    const pr = (geoapifyOk() ? geoapify(q).catch(() => photonFetch(q)) : photonFetch(q)).then(out => {
      searchCache.set(key, out);
      return out;
    }).finally(() => photonPending.delete(key));
    photonPending.set(key, pr);
    return pr;
  }
  function photonFetch(q) {
    const c = map.getCenter();
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=de&limit=7&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&location_bias_scale=0.3`;
    return fetch(url).then(r => r.json()).then(j => photonMap(j, q));
  }
  // Geoapify: schnell, 3.000 Anfragen/Tag gratis. Bei Fehlern (z. B. Kontingent leer) für eine Stunde Photon verwenden.
  let geoapifyBlockedUntil = 0;
  const geoapifyOk = () => !!window.RK_CONFIG.geoapifyKey && Date.now() > geoapifyBlockedUntil;
  async function geoapify(q) {
    const c = map.getCenter();
    const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(q)}&lang=de&limit=8&bias=proximity:${c.lng.toFixed(3)},${c.lat.toFixed(3)}&apiKey=${window.RK_CONFIG.geoapifyKey}`;
    const r = await fetch(url);
    if (!r.ok) { geoapifyBlockedUntil = Date.now() + 3600e3; throw new Error('geoapify ' + r.status); }
    const j = await r.json();
    const seen = new Set();
    return (j.features || []).map(f => {
      const p = f.properties || {};
      const raw = (p.datasource && p.datasource.raw) || {};
      const osmKey = ['tourism', 'historic', 'amenity', 'natural', 'leisure', 'waterway', 'place', 'boundary', 'man_made'].find(k => raw[k]);
      const name = p.name || p.address_line1 || p.formatted || q;
      return {
        name,
        sub: (p.name ? [p.address_line2] : [p.city, p.state, p.country]).filter(Boolean).join(', '),
        lat: p.lat, lng: p.lon,
        country: (p.country_code || '').toLowerCase() || null,
        extent: f.bbox || null,
        category: guessCategory(name, osmKey, osmKey && raw[osmKey]),
        address: p.formatted || '',
      };
    }).filter(r => { const k = `${r.name}|${r.sub}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  function photonMap(j, q) {
    const seen = new Set();
    return (j.features || []).filter(f => {
      const p = f.properties || {};
      const k = `${p.name}|${p.city || p.town || p.village || p.county}|${p.country}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).map(f => {
      const p = f.properties || {};
      const where = [p.city || p.town || p.village || p.county, p.state, p.country].filter(Boolean);
      const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '';
      return {
        name: p.name || street || where[0] || q,
        sub: [street && p.name ? street : '', ...where].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
        country: (p.countrycode || '').toLowerCase() || null,
        extent: p.extent,
        category: guessCategory(p.name, p.osm_key, p.osm_value),
        address: [p.name, street, p.postcode && (p.city || p.town) ? `${p.postcode} ${p.city || p.town}` : (p.city || p.town || p.village), p.country].filter(Boolean).join(', '),
      };
    });
  }

  // ---------- Links zu Google Maps ----------
  const routeUrl = p => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;
  const viewUrl = p => p.googleUrl || `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  function orderRoute(list, start) {
    const rest = list.slice(); const out = [];
    let cur = start || [rest[0].lat, rest[0].lng];
    while (rest.length) {
      let bi = 0, bd = Infinity;
      rest.forEach((p, i) => { const d = (p.lat - cur[0]) ** 2 + ((p.lng - cur[1]) * Math.cos(cur[0] * Math.PI / 180)) ** 2; if (d < bd) { bd = d; bi = i; } });
      const [p] = rest.splice(bi, 1); out.push(p); cur = [p.lat, p.lng];
    }
    return out;
  }
  function routeLegs(list, start) {
    const ordered = orderRoute(list, start);
    const legs = [];
    for (let i = 0; i < ordered.length; i += 10) {
      const chunk = ordered.slice(i, i + 10);
      const dest = chunk[chunk.length - 1];
      const wps = chunk.slice(0, -1).map(p => `${p.lat},${p.lng}`).join('|');
      const origin = i > 0 ? ordered[i - 1] : null;
      let url = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving`;
      if (origin) url += `&origin=${origin.lat},${origin.lng}`;
      if (wps) url += `&waypoints=${encodeURIComponent(wps)}`;
      legs.push({ url, from: i + 1, to: i + chunk.length, names: chunk.map(p => p.name) });
    }
    return legs;
  }

  // ---------- Sheet (mobil) ----------
  let snap = 'peek';
  const peekH = () => 158;
  const fullH = () => sheet.offsetHeight;
  const halfH = () => Math.round(window.innerHeight * 0.52);
  function sheetHeight() { return isDesktop() ? 0 : ({ peek: peekH(), half: halfH(), full: fullH() })[snap]; }
  function setSnap(s) {
    snap = s; sheet.dataset.snap = s;
    app.style.setProperty('--sheet-h', sheetHeight() + 'px');
  }
  (function sheetDrag() {
    const grip = $('#sheet-grip');
    let startY = 0, startH = 0, moved = false, dragging = false, lastY = 0, lastT = 0, vel = 0;
    function down(e) {
      if (isDesktop()) return;
      const inBody = e.currentTarget === body;
      if (inBody && (body.scrollTop > 0 || snap === 'full' || e.target.closest('input,textarea,select,button,a,.row,.group-head'))) return;
      dragging = true; moved = false; startY = lastY = e.clientY; lastT = e.timeStamp; startH = sheetHeight(); vel = 0;
      sheet.classList.add('dragging');
    }
    function move(e) {
      if (!dragging) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 6) moved = true;
      if (!moved) return;
      vel = (lastY - e.clientY) / Math.max(1, e.timeStamp - lastT); lastY = e.clientY; lastT = e.timeStamp;
      const h = Math.min(fullH(), Math.max(peekH() - 40, startH + dy));
      app.style.setProperty('--sheet-h', h + 'px');
    }
    function up(e) {
      if (!dragging) return;
      dragging = false; sheet.classList.remove('dragging');
      if (!moved) { if (e.currentTarget === grip || e.type === 'pointerup' && e.target.closest('#sheet-grip')) setSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek'); else setSnap(snap); return; }
      const h = parseFloat(app.style.getPropertyValue('--sheet-h'));
      const opts = [['peek', peekH()], ['half', halfH()], ['full', fullH()]];
      let target;
      if (vel > 0.5) target = h < halfH() ? 'half' : 'full';
      else if (vel < -0.5) target = h > halfH() ? 'half' : 'peek';
      else target = opts.reduce((a, b) => Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a)[0];
      setSnap(target);
    }
    [grip, body].forEach(el => el.addEventListener('pointerdown', down));
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('resize', () => setSnap(snap));
  })();
  function ensureSnap(min) {
    if (isDesktop()) return;
    const order = ['peek', 'half', 'full'];
    if (order.indexOf(snap) < order.indexOf(min)) setSnap(min);
  }

  // ---------- Ansichten ----------
  function current() { return ui.stack[ui.stack.length - 1] || { name: 'browse' }; }
  function openView(v, replace = false) {
    if (replace) ui.stack.pop();
    if (current().name === v.name && v.name !== 'browse' && JSON.stringify(current()) === JSON.stringify(v)) { render(); return; }
    ui.stack.push(v);
    render();
    body.scrollTop = 0;
    if (v.name !== 'browse') ensureSnap(v.name === 'edit' || v.name === 'settings' || v.name === 'tripEdit' ? 'full' : 'half');
  }
  function back() {
    const v = ui.stack.pop();
    if (v && (v.name === 'edit' || v.name === 'search')) clearTemp();
    if (v && v.name === 'trip' && !ui.stack.some(x => x.name === 'trip')) { /* Trip-Filter bleibt aktiv, bis er entfernt wird */ }
    if (!ui.stack.length) ui.stack.push({ name: 'browse' });
    select(current().name === 'place' ? current().id : null);
    render();
  }
  function home() { ui.stack = [{ name: 'browse' }]; clearTemp(); select(null); render(); }
  function select(id) {
    if (ui.selected === id) return;
    ui.selected = id;
    renderMarkers();
  }

  function render() {
    const v = current();
    const fn = VIEWS[v.name] || VIEWS.browse;
    body.innerHTML = fn(v);
    bind(v);
  }

  const headBack = (title, extra = '') => `<div class="view-head"><button class="icon-btn" data-act="back" aria-label="Zurück"><span class="ms">arrow_back</span></button><h2>${esc(title)}</h2>${extra}</div>`;

  function stats(list) {
    const countries = new Set(list.filter(p => p.country).map(p => p.country)).size;
    const done = list.filter(p => p.visited).length;
    return `<div class="stats">
      <div class="stat"><b>${countries}</b><span>Länder</span></div>
      <div class="stat"><b>${list.length}</b><span>Punkte</span></div>
      <div class="stat ok"><b>${done}</b><span>Erledigt</span></div></div>`;
  }

  function rowHtml(p, sub) {
    const c = cat(p.category);
    const where = [PRIO[p.prio] ? PRIO[p.prio].stars : '', p.country ? flag(p.country) + ' ' + (p.city || countryName(p.country)) : '', sub ?? c.name].filter(Boolean).join(' · ');
    return `<div class="row${p.visited ? ' done' : ''}">
      <button class="row-main" data-open="${p.id}">
        <span class="row-ico" style="background:${c.color}"><span class="ms fill">${c.icon}</span></span>
        <span class="row-text"><b>${esc(p.name)}</b><small>${esc(where)}${hasPos(p) ? '' : ' · ohne Position'}</small></span>
      </button>
      <button class="check${p.visited ? ' on' : ''}" data-toggle="${p.id}" aria-label="${p.visited ? 'Als offen markieren' : 'Abhaken'}"><span class="ms${p.visited ? ' fill' : ''}">${p.visited ? 'check_circle' : 'radio_button_unchecked'}</span></button>
    </div>`;
  }

  function filteredForList() {
    return S.places.filter(p => {
      if (ui.cats.size && !ui.cats.has(cat(p.category).id)) return false;
      if (ui.status === 'open' && p.visited) return false;
      if (ui.status === 'done' && !p.visited) return false;
      if (ui.activeTrip && !(p.tripIds || []).includes(ui.activeTrip)) return false;
      return true;
    });
  }
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'de');
  const prioRank = p => PRIO[p.prio] ? p.prio : 9;
  const byPrio = (a, b) => (prioRank(a) - prioRank(b)) || byName(a, b);
  const openFirst = (a, b) => (a.visited - b.visited) || byPrio(a, b);

  const VIEWS = {
    browse() {
      const all = S.places;
      const list = filteredForList();
      const trip = ui.activeTrip && S.trip(ui.activeTrip);
      const noPos = all.filter(p => !hasPos(p));
      let html = '';
      if (trip) html += `<div class="trip-filter"><span>Nur Trip: ${esc(trip.name)}</span><button class="icon-btn" data-act="clear-trip" aria-label="Trip-Filter entfernen"><span class="ms">close</span></button></div>`;
      html += stats(trip ? all.filter(p => (p.tripIds || []).includes(trip.id)) : all);
      if (!S.hasToken() && !lsGet('rk-hide-sync-hint', false)) {
        html += `<div class="notice"><span class="ms">sync</span><div><p><b>Mac und iPhone verbinden</b><br>Noch wird nur auf diesem Gerät gespeichert. Verbinde die Karte einmal mit deinem GitHub-Daten-Repo, dann sind deine Punkte überall gleich.</p><button class="linkbtn" data-act="settings">Jetzt verbinden <span class="ms">chevron_right</span></button> <button class="linkbtn" data-act="hide-hint">Später</button></div></div>`;
      }
      if (S.status === 'error') html += `<div class="notice warn"><span class="ms">cloud_off</span><div><p>${esc(S.statusText)}</p><button class="linkbtn" data-act="settings">Einstellungen öffnen</button></div></div>`;
      html += `<div class="seg" role="group" aria-label="Status">
        ${[['all', 'Alle'], ['open', 'Offen'], ['done', 'Erledigt ✅']].map(([k, l]) => `<button data-status="${k}" aria-pressed="${ui.status === k}">${l}</button>`).join('')}
      </div>`;
      html += `<div class="tabs" role="tablist">
        ${[['countries', 'public', 'Länder'], ['trips', 'luggage', 'Trips'], ['all', 'list', 'Alle']].map(([k, ic, l]) => `<button role="tab" data-tab="${k}" aria-selected="${ui.tab === k}"><span class="ms">${ic}</span>${l}</button>`).join('')}
      </div>`;
      if (noPos.length && !trip) html += `<div class="notice warn" style="margin-top:12px"><span class="ms">wrong_location</span><div><p><b>${noPos.length} ${noPos.length === 1 ? 'Punkt' : 'Punkte'} ohne Position</b><br>Beim Import wurde kein Ort gefunden. Tippe einen an und dann auf die Karte.</p><button class="linkbtn" data-act="nopos">Anzeigen <span class="ms">chevron_right</span></button></div></div>`;

      if (ui.tab === 'countries') html += countriesHtml(list);
      else if (ui.tab === 'trips') html += tripsHtml(list);
      else html += allHtml(list);
      if (!all.length) html += `<div class="notice" style="margin-top:16px"><span class="ms">add</span><div><p><b>Noch keine Punkte</b><br>Suche oben nach einem Ort oder halte den Finger länger auf die Karte (am Mac: Rechtsklick), um einen Punkt anzulegen.</p></div></div>`;
      return html;
    },

    place(v) {
      const p = S.place(v.id);
      if (!p) return headBack('Punkt') + '<p class="muted">Dieser Punkt wurde gelöscht.</p>';
      const c = cat(p.category);
      const trips = (p.tripIds || []).map(id => S.trip(id)).filter(Boolean);
      return `${headBack('', `<button class="icon-btn" data-act="edit" aria-label="Bearbeiten"><span class="ms">edit</span></button>`)}
        <h1 class="place-title">${esc(p.name)}</h1>
        <div class="meta-line">
          <span class="cat-pill" style="--c:${c.color}"><span class="ms fill">${c.icon}</span>${esc(c.name)}</span>
          <span>${flag(p.country)} ${esc(countryName(p.country))}</span>
          ${p.visited ? `<span class="done-pill"><span class="ms fill">check_circle</span>Erledigt${p.visitedDate ? ' am ' + fmtDate(p.visitedDate) : ''}</span>` : ''}
        </div>
        ${PRIO[p.prio] || p.info ? `<div class="prio-card${PRIO[p.prio] ? ' p' + p.prio : ''}">
          ${PRIO[p.prio] ? `<div class="prio-head"><span class="stars">${PRIO[p.prio].stars}</span> ${PRIO[p.prio].label}<span class="muted small"> · ${PRIO[p.prio].hint}</span></div>` : ''}
          ${p.info ? `<p>${esc(p.info).replace(/\n/g, '<br>')}</p>` : ''}
        </div>` : ''}
        <div class="actions">
          ${hasPos(p) ? `<a class="act primary big" href="${routeUrl(p)}" target="_blank" rel="noopener"><span class="ms fill">directions</span>Route starten</a>` : `<button class="act primary big" data-act="place-pos"><span class="ms">place</span>Position setzen</button>`}
          <button class="act big ${p.visited ? 'ok' : ''}" data-toggle="${p.id}"><span class="ms${p.visited ? ' fill' : ''}">${p.visited ? 'check_circle' : 'check'}</span>${p.visited ? 'Erledigt' : 'Abhaken'}</button>
          ${hasPos(p) ? `<a class="act big" href="${viewUrl(p)}" target="_blank" rel="noopener"><span class="ms">open_in_new</span>Google Maps</a>` : ''}
        </div>
        <div class="info-list">
          ${p.note ? `<div class="info"><span class="ms">edit</span><div>${esc(p.note).replace(/\n/g, '<br>')}</div></div>` : ''}
          ${p.address ? `<div class="info"><span class="ms">place</span><div>${esc(p.address)}</div></div>` : ''}
          <div class="info"><span class="ms">luggage</span><div>${trips.length ? trips.map(t => `<button class="trip-chip" style="--c:${t.color}" data-trip="${t.id}"><i></i>${esc(t.name)}</button>`).join('') : '<span class="muted">In keinem Trip</span> '}<button class="linkbtn" data-act="edit">Trips ändern</button></div></div>
          ${hasPos(p) ? `<div class="info"><span class="ms">my_location</span><div class="muted small">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · <button class="linkbtn small" data-act="place-pos">Position ändern</button></div></div>` : ''}
          <div class="info"><span class="ms">add</span><div class="muted small">Hinzugefügt ${fmtDate(p.createdAt)}</div></div>
        </div>
        <div class="danger-zone" id="dz"><button class="act danger" data-act="ask-delete"><span class="ms">delete</span>Löschen</button></div>`;
    },

    cluster(v) {
      const list = v.ids.map(id => S.place(id)).filter(Boolean).sort(openFirst);
      const done = list.filter(p => p.visited).length;
      return `${headBack(`${list.length} Orte hier`, `<button class="icon-btn" data-act="zoom-cluster" aria-label="Hineinzoomen"><span class="ms">zoom_in</span></button>`)}
        <p class="muted small" style="margin:0 0 6px">${done} von ${list.length} erledigt</p>
        ${list.map(p => rowHtml(p)).join('')}`;
    },

    search(v) {
      const r = v.result;
      const c = cat(r.category);
      return `${headBack('')}
        <h1 class="place-title">${esc(r.name)}</h1>
        <div class="meta-line"><span>${flag(r.country)} ${esc(r.sub || countryName(r.country))}</span></div>
        <div class="actions">
          <button class="act primary big" data-act="save-search"><span class="ms">add</span>Speichern</button>
          <a class="act big" href="${routeUrl(r)}" target="_blank" rel="noopener"><span class="ms">directions</span>Route</a>
          <a class="act big" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' ' + (r.sub || ''))}" target="_blank" rel="noopener"><span class="ms">open_in_new</span>Google Maps</a>
        </div>
        <div class="info-list"><div class="info"><span class="ms">place</span><div>${esc(r.address || r.sub)}</div></div>
        <div class="info"><span class="ms" style="color:${c.color}">${c.icon}</span><div class="muted">Vorgeschlagene Kategorie: ${esc(c.name)}</div></div></div>`;
    },

    edit(v) {
      const d = v.draft;
      const trips = S.trips.sort(byName);
      return `${headBack(d.id ? 'Punkt bearbeiten' : 'Neuer Punkt')}
        <form id="edit-form">
          <label class="field"><span>Name</span><input id="f-name" required value="${esc(d.name)}" placeholder="z. B. Kolosseum"></label>
          <div class="field"><span>Kategorie</span><div class="cat-grid">
            ${CATS.map(c => `<button type="button" class="cat-opt" style="--c:${c.color}" data-cat="${c.id}" aria-pressed="${d.category === c.id}"><span class="ico"><span class="ms fill">${c.icon}</span></span>${esc(c.name)}</button>`).join('')}
          </div></div>
          <div class="field"><span>Trips</span><div id="trip-opts">
            ${trips.map(t => `<button type="button" class="trip-chip" style="--c:${t.color}" data-tripopt="${t.id}" aria-pressed="${(d.tripIds || []).includes(t.id)}"><i></i>${esc(t.name)}</button>`).join('') || '<span class="muted small">Noch keine Trips angelegt.</span>'}
            </div>
            <div class="inline-add"><input id="f-newtrip" placeholder="Neuer Trip, z. B. Norwegen 2026"><button type="button" class="act" data-act="add-trip-inline"><span class="ms">add</span>Anlegen</button></div>
          </div>
          <div class="field"><span>Priorität</span><div class="seg" id="f-prio">
            ${[[1, '★★★ Must-see'], [2, '★★ Lohnt sich'], [3, '★ Optional'], [0, 'Keine']].map(([k, l]) => `<button type="button" data-prio="${k}" aria-pressed="${(d.prio || 0) === k}">${l}</button>`).join('')}
          </div></div>
          <label class="field"><span>Info: Was ist das, lohnt es sich?</span><textarea id="f-info" placeholder="Kurz beschreiben, was den Ort ausmacht und für wen er sich lohnt">${esc(d.info)}</textarea></label>
          <label class="field"><span>Notiz</span><textarea id="f-note" placeholder="Öffnungszeiten, Tipps, Eintritt …">${esc(d.note)}</textarea></label>
          <label class="field" style="display:flex;align-items:center;gap:10px"><input type="checkbox" id="f-visited" ${d.visited ? 'checked' : ''} style="width:22px;height:22px"> <span style="margin:0;font-size:15px;color:var(--ink)">Schon erledigt ✅</span></label>
          <p class="muted small">${d.country ? flag(d.country) + ' ' + esc(countryName(d.country)) : ''}${d.address ? ' · ' + esc(d.address) : ''}</p>
          <div class="form-actions"><button type="button" class="act" data-act="back">Abbrechen</button><button type="submit" class="act primary">Speichern</button></div>
        </form>`;
    },

    trip(v) {
      const t = S.trip(v.id);
      if (!t) return headBack('Trip') + '<p class="muted">Dieser Trip wurde gelöscht.</p>';
      const list = S.places.filter(p => (p.tripIds || []).includes(t.id)).sort(openFirst);
      const done = list.filter(p => p.visited).length;
      const open = list.filter(p => !p.visited && hasPos(p));
      const range = [t.start && fmtDate(t.start), t.end && fmtDate(t.end)].filter(Boolean).join(' – ');
      const legs = open.length ? routeLegs(open, v.start) : [];
      return `${headBack(t.name, `<button class="icon-btn" data-act="trip-edit" aria-label="Trip bearbeiten"><span class="ms">edit</span></button>`)}
        <p class="muted" style="margin:-4px 0 8px">${range ? esc(range) + ' · ' : ''}${done} von ${list.length} erledigt</p>
        <div class="progress" style="margin-bottom:14px"><i style="width:${list.length ? done / list.length * 100 : 0}%;background:${t.color}"></i></div>
        <div class="actions">
          ${legs.length === 1 ? `<a class="act primary big" href="${legs[0].url}" target="_blank" rel="noopener"><span class="ms fill">route</span>Ganze Route starten</a>` : ''}
          <button class="act big" data-act="trip-fit"><span class="ms">map</span>Auf Karte zeigen</button>
        </div>
        ${legs.length > 1 ? `<div class="field"><span>Route in Etappen (Google Maps erlaubt bis zu 10 Ziele pro Route)</span>${legs.map((l, i) => `<a class="act${i === 0 ? ' primary' : ''}" style="margin:0 6px 6px 0" href="${l.url}" target="_blank" rel="noopener"><span class="ms">route</span>Etappe ${i + 1} (${l.from}–${l.to})</a>`).join('')}</div>` : ''}
        ${open.length ? `<p class="muted small" style="margin:0 0 6px">Die Route führt von deinem Standort zu den ${open.length} offenen Punkten, jeweils zum nächstgelegenen.</p>` : ''}
        ${list.map(p => rowHtml(p)).join('') || '<p class="muted">Noch keine Punkte in diesem Trip. Öffne einen Punkt und wähle unter „Trips ändern“ diesen Trip aus.</p>'}`;
    },

    tripEdit(v) {
      const t = v.draft;
      return `${headBack(t.id ? 'Trip bearbeiten' : 'Neuer Trip')}
        <form id="trip-form">
          <label class="field"><span>Name</span><input id="t-name" required value="${esc(t.name)}" placeholder="z. B. Italien Roadtrip 2026"></label>
          <div class="two">
            <label class="field"><span>Von</span><input type="date" id="t-start" value="${esc(t.start || '')}"></label>
            <label class="field"><span>Bis</span><input type="date" id="t-end" value="${esc(t.end || '')}"></label>
          </div>
          <div class="field"><span>Farbe</span><div class="color-row">${TRIP_COLORS.map(c => `<button type="button" class="color-opt" style="--c:${c}" data-color="${c}" aria-pressed="${t.color === c}" aria-label="Farbe ${c}"></button>`).join('')}</div></div>
          <div class="form-actions">${t.id ? `<button type="button" class="act danger" data-act="ask-delete-trip" style="margin-right:auto"><span class="ms">delete</span>Löschen</button>` : ''}<button type="button" class="act" data-act="back">Abbrechen</button><button type="submit" class="act primary">Speichern</button></div>
          <div id="dz-trip"></div>
        </form>`;
    },

    nopos() {
      const list = S.places.filter(p => !hasPos(p)).sort(byName);
      return `${headBack('Ohne Position')}
        <p class="muted small" style="margin-top:0">Öffne einen Punkt und tippe auf „Position setzen“. Dann tippst du auf die richtige Stelle der Karte, oder du suchst vorher mit der Suchleiste danach.</p>
        ${list.map(p => rowHtml(p)).join('') || '<p class="muted">Alle Punkte haben eine Position.</p>'}`;
    },

    settings() {
      const st = { ok: 'Synchronisiert', syncing: 'Synchronisiere …', error: 'Fehler', offline: 'Offline', notoken: 'Nicht verbunden', local: 'Nicht verbunden' }[S.status] || '';
      return `${headBack('Einstellungen')}
        <div class="notice ${S.status === 'error' ? 'warn' : ''}"><span class="ms">${S.status === 'ok' ? 'cloud_done' : S.status === 'error' ? 'cloud_off' : 'sync'}</span><div><p><b>${st}</b><br><span class="small">${esc(S.statusText || (S.hasToken() ? '' : 'Punkte liegen nur auf diesem Gerät.'))}</span></p>${S.hasToken() ? '<button class="linkbtn" data-act="sync-now"><span class="ms">sync</span>Jetzt synchronisieren</button>' : ''}</div></div>
        <form id="token-form">
          <label class="field"><span>GitHub-Token (bleibt nur auf diesem Gerät)</span><input id="s-token" type="password" autocomplete="off" placeholder="${S.hasToken() ? '•••••••• gespeichert' : 'github_pat_…'}"></label>
          <label class="field"><span>Daten-Repo</span><input id="s-repo" value="${esc(S.repo())}"></label>
          <div class="form-actions" style="position:static"><button type="button" class="act danger" data-act="logout" ${S.hasToken() ? '' : 'hidden'}>Trennen</button><button type="submit" class="act primary">Verbinden</button></div>
        </form>
        <details style="margin:4px 0 16px"><summary style="cursor:pointer;font-weight:500">So bekommst du einen Token</summary>
          <ol class="steps">
            <li>Am Mac <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → Fine-grained token</a> öffnen.</li>
            <li>Name: <code>Reisekarte</code>, Ablaufdatum: z. B. 1 Jahr.</li>
            <li>Repository access: <b>Only select repositories</b> → <code>${esc(S.repo().split('/')[1] || '')}</code>.</li>
            <li>Permissions → Repository → <b>Contents: Read and write</b>.</li>
            <li>Token erstellen, kopieren und hier einfügen. Auf dem iPhone denselben Token einfügen (z. B. per AirDrop/Notizen übertragen).</li>
          </ol></details>
        <details style="margin:0 0 16px"><summary style="cursor:pointer;font-weight:500">Auf den iPhone-Home-Bildschirm legen</summary>
          <ol class="steps"><li>Diese Seite in <b>Safari</b> öffnen.</li><li>Unten auf das Teilen-Symbol tippen.</li><li><b>„Zum Home-Bildschirm“</b> wählen. Die Reisekarte startet dann wie eine App.</li></ol></details>
        <div class="field"><span>Sicherung</span>
          <button class="act" data-act="export"><span class="ms">download</span>Als Datei sichern</button>
          <label class="act" style="display:inline-flex;margin-left:6px"><span class="ms">upload</span>Datei einlesen<input type="file" id="s-import" accept="application/json,.json" hidden></label>
        </div>
        <p class="muted small">${S.places.length} Punkte · ${S.trips.length} Trips</p>`;
    },
  };

  function countriesHtml(list) {
    const groups = new Map();
    list.forEach(p => { const k = p.country || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
    const arr = [...groups.entries()].map(([cc, ps]) => ({ cc, ps, name: countryName(cc) }));
    const sort = ui.sort === 'count' ? (a, b) => b.ps.length - a.ps.length || a.name.localeCompare(b.name, 'de') : (a, b) => (a.cc ? 0 : 1) - (b.cc ? 0 : 1) || a.name.localeCompare(b.name, 'de');
    arr.sort(sort);
    let html = `<div class="toolbar"><span class="muted small">${arr.length} ${arr.length === 1 ? 'Land' : 'Länder'}</span>
      <select id="sort" aria-label="Sortieren"><option value="name" ${ui.sort !== 'count' ? 'selected' : ''}>A–Z</option><option value="count" ${ui.sort === 'count' ? 'selected' : ''}>Meiste Punkte</option></select></div>`;
    html += arr.map(g => {
      const done = g.ps.filter(p => p.visited).length;
      const key = 'c:' + g.cc;
      const open = ui.expanded.has(key);
      return `<div class="group"><button class="group-head" data-group="${key}" aria-expanded="${open}">
        <span class="flag">${flag(g.cc)}</span>
        <span class="g-main"><b>${esc(g.name)}</b><div class="progress"><i style="width:${done / g.ps.length * 100}%"></i></div></span>
        <span class="frac">${done}/${g.ps.length} ✅</span><span class="ms">${open ? 'expand_less' : 'expand_more'}</span></button>
        ${open ? `<div class="group-body">${g.ps.sort(openFirst).map(p => rowHtml(p)).join('')}</div>` : ''}</div>`;
    }).join('');
    return html;
  }

  function tripsHtml(list) {
    const trips = S.trips.slice().sort((a, b) => (b.start || '').localeCompare(a.start || '') || byName(a, b));
    let html = `<div class="toolbar"><span class="muted small">${trips.length} Trips</span><button class="linkbtn" data-act="new-trip"><span class="ms">add</span>Neuer Trip</button></div>`;
    html += trips.map(t => {
      const ps = list.filter(p => (p.tripIds || []).includes(t.id));
      const done = ps.filter(p => p.visited).length;
      const range = [t.start && fmtDate(t.start), t.end && fmtDate(t.end)].filter(Boolean).join(' – ');
      return `<div class="group"><button class="group-head" data-trip="${t.id}">
        <span class="g-ico" style="background:${t.color}"><span class="ms">luggage</span></span>
        <span class="g-main"><b>${esc(t.name)}</b><small>${range ? esc(range) : `${ps.length} Punkte`}</small><div class="progress"><i style="width:${ps.length ? done / ps.length * 100 : 0}%;background:${t.color}"></i></div></span>
        <span class="frac">${done}/${ps.length} ✅</span><span class="ms">chevron_right</span></button></div>`;
    }).join('');
    const loose = list.filter(p => !(p.tripIds || []).some(id => S.trip(id)));
    if (loose.length) {
      const open = ui.expanded.has('t:none');
      html += `<div class="group"><button class="group-head" data-group="t:none" aria-expanded="${open}">
        <span class="g-ico" style="background:var(--ink-3)"><span class="ms">place</span></span>
        <span class="g-main"><b>Ohne Trip</b><small>${loose.length} Punkte</small></span>
        <span class="frac">${loose.filter(p => p.visited).length}/${loose.length} ✅</span><span class="ms">${open ? 'expand_less' : 'expand_more'}</span></button>
        ${open ? `<div class="group-body">${loose.sort(openFirst).map(p => rowHtml(p)).join('')}</div>` : ''}</div>`;
    }
    if (!trips.length) html += `<p class="muted small">Mit Trips fasst du Punkte zu einer Reise zusammen und kannst die ganze Route in Google Maps starten.</p>`;
    return html;
  }

  function allHtml(list) {
    const tripName = p => { const t = (p.tripIds || []).map(id => S.trip(id)).find(Boolean); return t ? t.name : '~'; };
    const sorts = {
      name: byName,
      country: (a, b) => countryName(a.country).localeCompare(countryName(b.country), 'de') || byName(a, b),
      category: (a, b) => cat(a.category).name.localeCompare(cat(b.category).name, 'de') || byName(a, b),
      trip: (a, b) => tripName(a).localeCompare(tripName(b), 'de') || byName(a, b),
      date: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      open: openFirst,
      prio: byPrio,
    };
    const s = sorts[ui.sort] ? ui.sort : 'name';
    const sorted = list.slice().sort(sorts[s]);
    return `<div class="toolbar"><span class="muted small">${list.length} Punkte</span>
      <select id="sort" aria-label="Sortieren">
        ${[['name', 'Name'], ['country', 'Land'], ['category', 'Kategorie'], ['trip', 'Trip'], ['prio', 'Priorität'], ['open', 'Offene zuerst'], ['date', 'Zuletzt hinzugefügt']].map(([k, l]) => `<option value="${k}" ${s === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>` + sorted.map(p => rowHtml(p, s === 'trip' ? (tripName(p) === '~' ? 'Ohne Trip' : tripName(p)) : undefined)).join('');
  }

  // ---------- Ereignisse in Ansichten ----------
  function toggleVisited(id) {
    const p = S.place(id); if (!p) return;
    S.savePlace({ ...p, visited: !p.visited, visitedDate: !p.visited ? today() : null });
    toast(!p.visited ? `✅ ${p.name} abgehakt` : `${p.name} wieder offen`);
  }
  function openPlace(id, fly = true) {
    const p = S.place(id); if (!p) return;
    clearTemp();
    if (current().name === 'place') openView({ name: 'place', id }, true); else openView({ name: 'place', id });
    select(id);
    if (fly && hasPos(p)) focusOn(p.lat, p.lng);
  }
  function openTrip(id) {
    ui.activeTrip = id;
    openView({ name: 'trip', id });
    renderMarkers(); renderChips();
    fitPlaces(S.places.filter(p => (p.tripIds || []).includes(id)));
    if (lastPos) { current().start = lastPos; render(); }
    else locate(false).then(pos => { if (pos && current().name === 'trip' && current().id === id) { current().start = pos; render(); } });
  }

  function bind(v) {
    body.querySelectorAll('[data-act="back"]').forEach(b => b.onclick = back);
    body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openPlace(b.dataset.open));
    body.querySelectorAll('[data-toggle]').forEach(b => b.onclick = e => { e.stopPropagation(); toggleVisited(b.dataset.toggle); });
    body.querySelectorAll('[data-trip]').forEach(b => b.onclick = () => openTrip(b.dataset.trip));
    body.querySelectorAll('[data-status]').forEach(b => b.onclick = () => { ui.status = b.dataset.status; lsSet('rk-status', ui.status); renderMarkers(); render(); });
    body.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { ui.tab = b.dataset.tab; lsSet('rk-tab', ui.tab); render(); });
    body.querySelectorAll('[data-group]').forEach(b => b.onclick = () => {
      const k = b.dataset.group;
      if (ui.expanded.has(k)) ui.expanded.delete(k);
      else {
        ui.expanded.add(k);
        if (k.startsWith('c:')) fitPlaces(filteredForList().filter(p => (p.country || '') === k.slice(2)));
      }
      render();
    });
    const sort = body.querySelector('#sort');
    if (sort) sort.onchange = () => { ui.sort = sort.value; lsSet('rk-sort', ui.sort); render(); };
    const on = (act, fn) => body.querySelectorAll(`[data-act="${act}"]`).forEach(b => b.onclick = fn);

    on('settings', () => openView({ name: 'settings' }));
    on('hide-hint', () => { lsSet('rk-hide-sync-hint', true); render(); });
    on('clear-trip', () => { ui.activeTrip = null; renderMarkers(); renderChips(); render(); });
    on('nopos', () => openView({ name: 'nopos' }));
    on('new-trip', () => openView({ name: 'tripEdit', draft: { name: '', color: TRIP_COLORS[S.trips.length % TRIP_COLORS.length] } }));

    if (v.name === 'place') {
      const p = S.place(v.id);
      on('edit', () => openView({ name: 'edit', draft: { ...p } }));
      on('place-pos', () => startPlacing(p.id));
      on('ask-delete', () => {
        $('#dz').innerHTML = `<span>„${esc(p.name)}“ wirklich löschen?</span><button class="act danger" id="del-yes">Löschen</button><button class="act" id="del-no">Abbrechen</button>`;
        $('#del-yes').onclick = () => { S.deletePlace(p.id); toast('Punkt gelöscht'); back(); };
        $('#del-no').onclick = render;
      });
    }
    if (v.name === 'cluster') on('zoom-cluster', () => { fitPlaces(v.ids.map(id => S.place(id)).filter(Boolean)); });
    if (v.name === 'search') on('save-search', () => {
      const r = v.result;
      openView({ name: 'edit', draft: { name: r.name, lat: r.lat, lng: r.lng, country: r.country, category: r.category, address: r.address, city: r.sub?.split(',')[0] || '', tripIds: ui.activeTrip ? [ui.activeTrip] : [], note: '' } });
      setTemp(r.lat, r.lng);
    });
    if (v.name === 'edit') bindEdit(v);
    if (v.name === 'trip') {
      on('trip-edit', () => openView({ name: 'tripEdit', draft: { ...S.trip(v.id) } }));
      on('trip-fit', () => fitPlaces(S.places.filter(p => (p.tripIds || []).includes(v.id))));
    }
    if (v.name === 'tripEdit') bindTripEdit(v);
    if (v.name === 'settings') bindSettings();
  }

  function bindEdit(v) {
    const d = v.draft;
    const f = $('#edit-form');
    const keep = () => { d.name = $('#f-name').value; d.info = $('#f-info').value.trim(); d.note = $('#f-note').value; d.visited = $('#f-visited').checked; };
    f.querySelectorAll('[data-prio]').forEach(b => b.onclick = () => { d.prio = +b.dataset.prio || null; f.querySelectorAll('[data-prio]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
    f.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { keep(); d.category = b.dataset.cat; f.querySelectorAll('[data-cat]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
    f.querySelectorAll('[data-tripopt]').forEach(b => b.onclick = () => {
      const id = b.dataset.tripopt; d.tripIds = d.tripIds || [];
      d.tripIds = d.tripIds.includes(id) ? d.tripIds.filter(x => x !== id) : [...d.tripIds, id];
      b.setAttribute('aria-pressed', d.tripIds.includes(id));
    });
    f.querySelector('[data-act="add-trip-inline"]').onclick = () => {
      const name = $('#f-newtrip').value.trim(); if (!name) return;
      keep();
      const t = S.saveTrip({ name, color: TRIP_COLORS[S.trips.length % TRIP_COLORS.length] });
      d.tripIds = [...(d.tripIds || []), t.id];
      render();
    };
    $('#f-newtrip').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); f.querySelector('[data-act="add-trip-inline"]').click(); } };
    f.onsubmit = e => {
      e.preventDefault(); keep();
      if (!d.name.trim()) return;
      if (!d.category) d.category = 'sonstiges';
      const wasVisited = d.id ? S.place(d.id)?.visited : false;
      if (d.visited && !wasVisited) d.visitedDate = today();
      if (!d.visited) d.visitedDate = null;
      const saved = S.savePlace({ ...d, name: d.name.trim() });
      clearTemp();
      toast(d.id ? 'Gespeichert' : `${saved.name} gespeichert`);
      ui.stack = ui.stack.filter(x => x.name !== 'edit' && x.name !== 'search');
      if (!ui.stack.length) ui.stack.push({ name: 'browse' });
      openPlace(saved.id, false);
    };
  }

  function bindTripEdit(v) {
    const t = v.draft;
    const f = $('#trip-form');
    f.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { t.color = b.dataset.color; f.querySelectorAll('[data-color]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
    f.onsubmit = e => {
      e.preventDefault();
      const name = $('#t-name').value.trim(); if (!name) return;
      const saved = S.saveTrip({ ...t, name, start: $('#t-start').value || null, end: $('#t-end').value || null, color: t.color || TRIP_COLORS[0] });
      toast('Trip gespeichert');
      ui.stack.pop();
      if (current().name === 'trip') render(); else openTrip(saved.id);
    };
    const del = f.querySelector('[data-act="ask-delete-trip"]');
    if (del) del.onclick = () => {
      $('#dz-trip').innerHTML = `<div class="notice warn"><span class="ms">delete</span><div><p>Trip „${esc(t.name)}“ löschen? Die Punkte selbst bleiben erhalten.</p><button type="button" class="act danger" id="tdel-yes">Trip löschen</button> <button type="button" class="act" id="tdel-no">Abbrechen</button></div></div>`;
      $('#tdel-yes').onclick = () => { S.deleteTrip(t.id); if (ui.activeTrip === t.id) ui.activeTrip = null; toast('Trip gelöscht'); home(); renderMarkers(); renderChips(); };
      $('#tdel-no').onclick = () => { $('#dz-trip').innerHTML = ''; };
    };
  }

  function bindSettings() {
    $('#token-form').onsubmit = async e => {
      e.preventDefault();
      const token = $('#s-token').value.trim();
      const repo = $('#s-repo').value.trim();
      if (!token && !S.hasToken()) { toast('Bitte zuerst einen Token einfügen.'); return; }
      await S.setToken(token || localStorage.getItem('rk-token'), repo);
      render();
      if (S.status === 'ok') toast('Verbunden ✅');
    };
    const on = (act, fn) => body.querySelectorAll(`[data-act="${act}"]`).forEach(b => b.onclick = fn);
    on('logout', async () => { await S.setToken(null); render(); toast('Verbindung getrennt'); });
    on('sync-now', async () => { await S.sync(); render(); });
    on('export', () => {
      const blob = new Blob([S.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `reisekarte-${today()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('#s-import').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try { const data = JSON.parse(await file.text()); S.importData(data); toast(`${(data.places || []).length} Punkte eingelesen`); render(); }
      catch { toast('Die Datei konnte nicht gelesen werden.'); }
    };
  }

  // ---------- Punkt auf der Karte platzieren ----------
  function startPlacing(id) {
    const p = S.place(id); if (!p) return;
    ui.placing = { id };
    const b = $('#banner');
    b.innerHTML = `<span>Tippe auf die Karte, um „${esc(p.name)}“ zu platzieren</span><button id="place-cancel">Abbrechen</button>`;
    b.hidden = false;
    $('#place-cancel').onclick = stopPlacing;
    if (!isDesktop()) setSnap('peek');
    map.getContainer().style.cursor = 'crosshair';
  }
  function stopPlacing() { ui.placing = null; $('#banner').hidden = true; map.getContainer().style.cursor = ''; }
  map.on('click', async e => {
    if (ui.placing) {
      const p = S.place(ui.placing.id); stopPlacing();
      if (!p) return;
      const { lat, lng } = e.latlng;
      S.savePlace({ ...p, lat, lng });
      openPlace(p.id, false);
      const info = await reverse(lat, lng);
      if (info) { const cur = S.place(p.id); S.savePlace({ ...cur, country: info.country || cur.country, address: info.address || cur.address, city: info.city || cur.city }); }
      return;
    }
    // Klick auf leere Karte: auf Mobilgeräten Sheet einklappen
    if (!isDesktop() && snap !== 'peek' && current().name !== 'edit') setSnap('peek');
  });

  // Neuen Punkt per Rechtsklick (Mac) oder langem Drücken (iPhone)
  async function newPointAt(latlng) {
    const { lat, lng } = latlng;
    setTemp(lat, lng);
    const draft = { name: '', lat, lng, category: 'sonstiges', tripIds: ui.activeTrip ? [ui.activeTrip] : [], note: '' };
    openView({ name: 'edit', draft });
    const info = await reverse(lat, lng);
    if (info && current().draft === draft) {
      Object.assign(draft, { country: info.country, address: info.address, city: info.city });
      if (!$('#f-name').value) draft.name = info.name;
      else draft.name = $('#f-name').value;
      if (draft.category === 'sonstiges') draft.category = info.category;
      draft.note = $('#f-note').value;
      render();
    }
  }
  map.on('contextmenu', e => { if (!ui.placing) newPointAt(e.latlng); });
  (function longPress() {
    const el = map.getContainer();
    let timer = null, start = null;
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { clearTimeout(timer); return; }
      const t = e.touches[0]; start = [t.clientX, t.clientY];
      timer = setTimeout(() => {
        const rect = el.getBoundingClientRect();
        const ll = map.containerPointToLatLng([start[0] - rect.left, start[1] - rect.top]);
        navigator.vibrate?.(30);
        newPointAt(ll);
      }, 600);
    }, { passive: true });
    el.addEventListener('touchmove', e => { const t = e.touches[0]; if (start && Math.hypot(t.clientX - start[0], t.clientY - start[1]) > 10) clearTimeout(timer); }, { passive: true });
    ['touchend', 'touchcancel'].forEach(ev => el.addEventListener(ev, () => clearTimeout(timer), { passive: true }));
    map.on('movestart zoomstart', () => clearTimeout(timer));
  })();

  // ---------- Suche ----------
  const q = $('#q'), results = $('#results');
  let searchTimer = null, lastResults = [], activeIdx = -1;
  function savedMatches(term) {
    const t = norm(term);
    return S.places.filter(p => norm(p.name).includes(t) || norm(p.note).includes(t) || norm(p.address).includes(t) || norm(countryName(p.country)).includes(t)).sort(byName).slice(0, 6);
  }
  function renderResults(saved, remote, loading) {
    let html = '';
    if (saved.length) html += `<h4>Gespeichert</h4>` + saved.map(p => { const c = cat(p.category); return `<button class="result" data-saved="${p.id}"><span class="r-ico" style="background:${c.color};color:#fff"><span class="ms fill">${c.icon}</span></span><div><b>${esc(p.name)}${p.visited ? ' ✅' : ''}</b><small>${flag(p.country)} ${esc(p.city || countryName(p.country))}</small></div></button>`; }).join('');
    if (remote.length) html += `<h4>Orte</h4>` + remote.map((r, i) => `<button class="result" data-remote="${i}"><span class="r-ico"><span class="ms">place</span></span><div><b>${esc(r.name)}</b><small>${flag(r.country)} ${esc(r.sub)}</small></div></button>`).join('');
    if (loading && !remote.length) html += `<div class="empty">Suche … <span class="small">Mit Enter bzw. „Suchen“ geht es schneller.</span></div>`;
    if (!loading && !saved.length && !remote.length) html += `<div class="empty">Keine Treffer.</div>`;
    results.innerHTML = html;
    results.hidden = false;
    activeIdx = -1;
    results.querySelectorAll('[data-saved]').forEach(b => b.onclick = () => { closeSearch(); openPlace(b.dataset.saved); });
    results.querySelectorAll('[data-remote]').forEach(b => b.onclick = () => pickRemote(lastResults[+b.dataset.remote]));
  }
  function pickRemote(r) {
    closeSearch();
    q.value = r.name;
    $('#search-clear').hidden = false;
    select(null);
    setTemp(r.lat, r.lng);
    openView({ name: 'search', result: r });
    if (r.extent && Math.abs(r.extent[2] - r.extent[0]) > 0.02) {
      const b = L.latLngBounds([r.extent[1], r.extent[0]], [r.extent[3], r.extent[2]]);
      map.flyToBounds(b, isDesktop() ? { paddingTopLeft: [430, 60], duration: .6 } : { paddingBottomRight: [0, sheetHeight()], paddingTopLeft: [0, 100], duration: .6 });
    } else focusOn(r.lat, r.lng, 15);
  }
  function closeSearch() { results.hidden = true; q.blur(); }
  let shownFor = '';   // Suchbegriff, dessen Vorschläge gerade angezeigt werden
  function bestCached(term) {
    // längster schon beantworteter Anfang des aktuellen Begriffs
    for (let i = term.length; i >= 3; i--) {
      const hit = searchCache.get('p|' + norm(term.slice(0, i)));
      if (hit) return { t: term.slice(0, i), res: hit };
    }
    return null;
  }
  function showSuggestions(term) {
    const cur = q.value.trim();
    if (submitted || document.activeElement !== q || !norm(cur).startsWith(norm(term))) return; // Suche schon geschlossen
    if (shownFor && norm(shownFor).length > norm(term).length && norm(cur).startsWith(norm(shownFor))) return; // Genaueres wird schon gezeigt
    let res = searchCache.get('p|' + norm(term)) || [];
    if (norm(term) !== norm(cur)) {
      // Ergebnisse für einen Anfang nur zeigen, soweit sie zum aktuell Getippten passen
      const words = norm(cur).split(/\s+/).filter(Boolean);
      res = res.filter(r => { const h = norm(r.name + ' ' + r.sub); return words.every(w => h.includes(w)); });
    }
    shownFor = term;
    lastResults = res;
    renderResults(savedMatches(cur), res, norm(term) !== norm(cur));
  }
  q.addEventListener('input', () => {
    const term = q.value.trim();
    $('#search-clear').hidden = !q.value;
    clearTimeout(searchTimer);
    if (term.length < 2) { results.hidden = true; shownFor = ''; return; }
    if (shownFor && !norm(term).startsWith(norm(shownFor))) shownFor = '';
    const cached = bestCached(term);
    if (cached) { shownFor = ''; showSuggestions(cached.t); }
    else renderResults(savedMatches(term), [], true);
    if (term.length < 3) return;
    searchTimer = setTimeout(() => {
      photon(term).then(() => showSuggestions(term)).catch(() => { if (q.value.trim() === term && !lastResults.length) renderResults(savedMatches(term), [], false); });
    }, 120);
  });
  let submitted = false;
  q.addEventListener('input', () => { submitted = false; });
  async function quickSearch() {
    const term = q.value.trim();
    if (term.length < 2) return;
    clearTimeout(searchTimer);
    submitted = true;
    const saved = savedMatches(term);
    renderResults(saved, [], true);
    try {
      const res = await nominatimSearch(term);
      if (q.value.trim() !== term) return;
      if (!res.length) {
        // nichts gefunden: auf die Vorschlagssuche zurückfallen
        const alt = await photon(term).catch(() => []);
        if (q.value.trim() !== term) return;
        lastResults = alt; renderResults(saved, alt, false); return;
      }
      lastResults = res;
      if (res.length === 1 && !saved.length) pickRemote(res[0]);
      else renderResults(saved, res, false);
    } catch { renderResults(saved, lastResults, false); }
  }
  q.addEventListener('keydown', e => {
    const items = [...results.querySelectorAll('.result')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'Escape') { closeSearch(); }
  });
  $('#searchform').onsubmit = e => {
    e.preventDefault();
    const items = [...results.querySelectorAll('.result')];
    if (activeIdx >= 0 && items[activeIdx]) items[activeIdx].click();
    else quickSearch();
  };
  q.addEventListener('focus', () => { if (q.value.trim().length >= 2 && results.innerHTML) results.hidden = false; });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.topbar')) results.hidden = true; });
  $('#search-clear').onclick = () => { q.value = ''; $('#search-clear').hidden = true; results.hidden = true; if (current().name === 'search') back(); q.focus(); };
  $('#search-lead').onclick = () => q.focus();
  $('#sync-btn').onclick = () => openView({ name: 'settings' });

  // ---------- Kategorie-Chips ----------
  function renderChips() {
    const counts = {};
    S.places.forEach(p => { const id = cat(p.category).id; counts[id] = (counts[id] || 0) + 1; });
    const shown = CATS.filter(c => counts[c.id] || ui.cats.has(c.id));
    const list = shown.length ? shown : CATS.slice(0, 4);
    $('#chips').innerHTML =
      (ui.cats.size ? `<button class="chip plain" data-chip="__all"><span class="ms">close</span>Alle</button>` : '') +
      list.map(c => `<button class="chip" style="--c:${c.color}" data-chip="${c.id}" aria-pressed="${ui.cats.has(c.id)}"><span class="ms fill">${c.icon}</span>${esc(c.plural || c.name)}${counts[c.id] ? ` <span class="count">${counts[c.id]}</span>` : ''}</button>`).join('');
    $('#chips').querySelectorAll('[data-chip]').forEach(b => b.onclick = () => {
      const id = b.dataset.chip;
      if (id === '__all') ui.cats.clear();
      else if (ui.cats.has(id)) ui.cats.delete(id); else ui.cats.add(id);
      lsSet('rk-cats', [...ui.cats]);
      renderChips(); renderMarkers();
      if (current().name === 'browse') render();
    });
  }

  // ---------- Sync-Anzeige ----------
  function renderSync() {
    const b = $('#sync-btn');
    b.dataset.status = S.status;
    b.title = S.statusText || '';
  }

  // ---------- Start ----------
  S.onChange(() => {
    renderSync();
    renderMarkers();
    renderChips();
    const v = current();
    if (['browse', 'place', 'cluster', 'trip', 'nopos', 'settings'].includes(v.name) && !body.contains(document.activeElement && document.activeElement.matches('input,textarea,select') ? document.activeElement : null)) render();
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && !results.hidden) return; if (e.key === 'Escape' && ui.placing) stopPlacing(); else if (e.key === 'Escape' && ui.stack.length > 1 && document.activeElement === document.body) back(); });

  ui.stack = [{ name: 'browse' }];
  setSnap('peek');
  renderChips();
  renderMarkers();
  renderSync();
  render();
  if (!lsGet('rk-view', null) && S.places.some(hasPos)) fitPlaces(S.places);
  S.sync();
  // erste Anpassung an geladene Daten
  let fitted = !!lsGet('rk-view', null);
  S.onChange(() => { if (!fitted && S.places.some(hasPos)) { fitted = true; fitPlaces(S.places); } });
})();
