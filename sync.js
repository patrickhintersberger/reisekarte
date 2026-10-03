// Datenhaltung: lokaler Cache (localStorage) + Synchronisation mit einer JSON-Datei
// in einem privaten GitHub-Repo. Zusammenführung pro Eintrag nach updatedAt,
// Löschungen bleiben als "deleted"-Markierung erhalten, damit sie sich auf alle Geräte übertragen.
(function () {
  const LS_STATE = 'rk-state-v1';
  const LS_TOKEN = 'rk-token';
  const LS_REPO = 'rk-repo';
  const cfg = window.RK_CONFIG;

  const store = {
    places: {},   // id -> place
    trips: {},    // id -> trip
    sha: null,
    dirty: false,
    status: 'local', // local | syncing | ok | error | offline | notoken
    statusText: '',
    listeners: new Set(),
  };

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

  function loadLocal() {
    const raw = lsGet(LS_STATE);
    if (!raw) return;
    try {
      const s = JSON.parse(raw);
      store.places = s.places || {};
      store.trips = s.trips || {};
      store.sha = s.sha || null;
      store.dirty = !!s.dirty;
    } catch {}
  }
  function saveLocal() {
    lsSet(LS_STATE, JSON.stringify({ places: store.places, trips: store.trips, sha: store.sha, dirty: store.dirty }));
  }

  function emit() { store.listeners.forEach(fn => fn()); }
  function setStatus(s, text = '') { store.status = s; store.statusText = text; emit(); }

  function getToken() { return lsGet(LS_TOKEN); }
  function getRepo() {
    const r = lsGet(LS_REPO);
    return r || `${cfg.owner}/${cfg.dataRepo}`;
  }

  // ---------- Base64 mit UTF-8 ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- Zusammenführen ----------
  function mergeMaps(a, b) {
    const out = { ...a };
    for (const [id, item] of Object.entries(b || {})) {
      const mine = out[id];
      if (!mine || (item.updatedAt || 0) > (mine.updatedAt || 0)) out[id] = item;
    }
    return out;
  }
  function toMap(arr) { const m = {}; (arr || []).forEach(x => { if (x && x.id) m[x.id] = x; }); return m; }
  function sameMaps(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => b[k] && (a[k].updatedAt || 0) === (b[k].updatedAt || 0));
  }
  function serialize() {
    const byName = (x, y) => (x.name || '').localeCompare(y.name || '');
    return JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      trips: Object.values(store.trips).sort(byName),
      places: Object.values(store.places).sort(byName),
    }, null, 1);
  }

  // ---------- GitHub API ----------
  async function gh(method, body) {
    const token = getToken();
    const url = `https://api.github.com/repos/${getRepo()}/contents/${cfg.dataPath}` + (method === 'GET' ? `?ref=${cfg.branch}` : '');
    const res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  async function fetchRemote() {
    const res = await gh('GET');
    if (res.status === 401) throw new Error(ERR.badToken);
    if (res.status === 403) throw new Error(ERR.noRights);
    if (res.status === 404) {
      // Unterscheiden: Datei fehlt noch, oder der Token sieht das Repo gar nicht
      const repo = await fetch(`https://api.github.com/repos/${getRepo()}`, { cache: 'no-store', headers: { 'Authorization': `Bearer ${getToken()}`, 'Accept': 'application/vnd.github+json' } });
      if (!repo.ok) throw new Error(ERR.noRepo());
      return { missing: true };
    }
    if (!res.ok) throw new Error(`GitHub antwortet mit Fehler ${res.status}.`);
    const meta = await res.json();
    let text;
    if (meta.content && meta.encoding === 'base64') text = b64decode(meta.content);
    else {
      // Datei > 1 MB: Inhalt über dieselbe API als Rohtext holen
      // (der Download-Link auf raw.githubusercontent.com lässt sich mit Token aus dem Browser nicht abrufen)
      const raw = await fetch(`https://api.github.com/repos/${getRepo()}/contents/${cfg.dataPath}?ref=${cfg.branch}`, {
        cache: 'no-store',
        headers: { 'Authorization': `Bearer ${getToken()}`, 'Accept': 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!raw.ok) throw new Error(`GitHub antwortet mit Fehler ${raw.status}.`);
      text = await raw.text();
    }
    const data = text.trim() ? JSON.parse(text) : {};
    return { sha: meta.sha, places: toMap(data.places), trips: toMap(data.trips) };
  }

  const ERR = {
    badToken: 'GitHub kennt diesen Token nicht. Meist wurde er nicht vollständig kopiert. Kopiere ihn auf GitHub mit dem Kopier-Symbol neu, tippe hier auf „Trennen“, füge ihn ein und tippe auf „Verbinden“.',
    noRights: 'Der Token darf nicht schreiben. Stelle auf GitHub beim Token unter Permissions → Repository → „Contents“ auf „Read and write“.',
    noRepo: () => `Der Token hat keinen Zugriff auf „${getRepo()}“. Wähle auf GitHub beim Token unter Repository access „Only select repositories“ → „${getRepo().split('/')[1]}“.`,
  };

  let syncing = null;
  let again = false;

  async function sync() {
    if (!getToken()) { setStatus('notoken', 'Nur auf diesem Gerät gespeichert'); return; }
    if (!navigator.onLine) { setStatus('offline', 'Offline – wird später synchronisiert'); return; }
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      setStatus('syncing', 'Synchronisiere …');
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const remote = await fetchRemote();
          const mergedPlaces = mergeMaps(store.places, remote.places || {});
          const mergedTrips = mergeMaps(store.trips, remote.trips || {});
          const changedLocal = !sameMaps(mergedPlaces, store.places) || !sameMaps(mergedTrips, store.trips);
          store.places = mergedPlaces;
          store.trips = mergedTrips;
          store.sha = remote.sha || null;
          const needPush = remote.missing || !sameMaps(mergedPlaces, remote.places || {}) || !sameMaps(mergedTrips, remote.trips || {});
          if (changedLocal) emit();
          if (!needPush) { store.dirty = false; saveLocal(); break; }
          const res = await gh('PUT', {
            message: `Reisekarte aktualisiert (${new Date().toLocaleString('de-DE')})`,
            content: b64encode(serialize()),
            branch: cfg.branch,
            ...(store.sha ? { sha: store.sha } : {}),
          });
          if (res.status === 409 || res.status === 422) continue; // jemand anders war schneller -> neu zusammenführen
          if (res.status === 401) throw new Error(ERR.badToken);
          if (res.status === 403) throw new Error(ERR.noRights);
          if (res.status === 404) throw new Error(ERR.noRepo());
          if (!res.ok) throw new Error(`Speichern fehlgeschlagen (Fehler ${res.status}).`);
          const out = await res.json();
          store.sha = out.content && out.content.sha;
          store.dirty = false;
          saveLocal();
          break;
        }
        setStatus('ok', 'Synchronisiert ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
      } catch (e) {
        saveLocal();
        setStatus('error', e.message || 'Synchronisation fehlgeschlagen');
      } finally {
        syncing = null;
        if (again) { again = false; setTimeout(sync, 300); }
      }
    })();
    return syncing;
  }

  let pushTimer = null;
  function schedulePush() {
    store.dirty = true;
    saveLocal();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(sync, 1200);
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------- öffentliche API ----------
  window.RK_STORE = {
    get places() { return Object.values(store.places).filter(p => !p.deleted); },
    get trips() { return Object.values(store.trips).filter(t => !t.deleted); },
    place(id) { const p = store.places[id]; return p && !p.deleted ? p : null; },
    trip(id) { const t = store.trips[id]; return t && !t.deleted ? t : null; },
    get status() { return store.status; },
    get statusText() { return store.statusText; },
    get dirty() { return store.dirty; },
    hasToken() { return !!getToken(); },
    repo: getRepo,
    setToken(token, repo) {
      if (token) lsSet(LS_TOKEN, token.replace(/\s+/g, '')); else lsDel(LS_TOKEN);
      if (repo && repo.trim() && repo.trim() !== `${cfg.owner}/${cfg.dataRepo}`) lsSet(LS_REPO, repo.trim()); else lsDel(LS_REPO);
      store.sha = null;
      return sync();
    },
    onChange(fn) { store.listeners.add(fn); },
    uid,
    savePlace(p) {
      const now = Date.now();
      const item = { createdAt: now, tripIds: [], visited: false, ...p, updatedAt: now };
      if (!item.id) item.id = uid();
      store.places[item.id] = item;
      emit(); schedulePush();
      return item;
    },
    deletePlace(id) {
      const p = store.places[id]; if (!p) return;
      store.places[id] = { id, deleted: true, updatedAt: Date.now() };
      emit(); schedulePush();
    },
    saveTrip(t) {
      const now = Date.now();
      const item = { createdAt: now, ...t, updatedAt: now };
      if (!item.id) item.id = uid();
      store.trips[item.id] = item;
      emit(); schedulePush();
      return item;
    },
    deleteTrip(id) {
      store.trips[id] = { id, deleted: true, updatedAt: Date.now() };
      const now = Date.now();
      Object.values(store.places).forEach(p => {
        if (!p.deleted && (p.tripIds || []).includes(id)) {
          store.places[p.id] = { ...p, tripIds: p.tripIds.filter(x => x !== id), updatedAt: now };
        }
      });
      emit(); schedulePush();
    },
    importData(data) {
      const now = Date.now();
      // Nur fehlende Einträge übernehmen, vorhandene (evtl. bearbeitete/abgehakte) bleiben unverändert.
      (data.trips || []).forEach(t => { if (t.id && !store.trips[t.id]) store.trips[t.id] = { ...t, updatedAt: now }; });
      (data.places || []).forEach(p => { if (p.id && !store.places[p.id]) store.places[p.id] = { ...p, updatedAt: now }; });
      emit(); schedulePush();
    },
    exportJSON: serialize,
    sync,
  };

  loadLocal();
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 90000);
})();
