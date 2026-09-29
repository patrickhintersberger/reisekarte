#!/usr/bin/env python3
"""Importiert gespeicherte Orte aus einem Google-Takeout-Export in die Reisekarte.

Aufruf:
  python3 tools/import_takeout.py <Takeout-Ordner> --existing places.json --out places.json

Liest:
  - Gespeichert/*.csv (bzw. Saved/*.csv): jede Liste wird ein Trip
  - Gespeicherte Orte.json / Saved Places.json (GeoJSON, markierte Orte)
  - *.kml / *.kmz (Meine Karten)

Koordinaten kommen aus dem Google-Link (URL oder Google-Ortsdaten), ersatzweise aus der
OpenStreetMap-Suche (Nominatim). Land und Kategorie werden per Nominatim bestimmt.
Vorhandene Punkte (gleicher Google-Link oder gleicher Name in < 150 m) werden nicht
überschrieben, nur um Trips ergänzt.
"""
import argparse, csv, hashlib, html, io, json, math, os, re, sys, time, zipfile
import urllib.parse, urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(HERE, 'geocode_cache.json')
UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
UA_NOMINATIM = 'Reisekarte-Import/1.0 (+https://github.com/patrickhintersberger/reisekarte)'
GOOGLE_HEADERS = {
    'User-Agent': UA_BROWSER, 'Accept-Language': 'de-DE,de;q=0.9',
    'Cookie': 'CONSENT=YES+cb.20240101-00-p0.de+FX+000; SOCS=CAISHAgBEhJnd3NfMjAyNDAxMDEtMF9SQzIaAmRlIAEaBgiA_LyuBg',
}
TRIP_COLORS = ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#12b5cb', '#e52592', '#f9ab00', '#5f6368', '#795548']

# --- Kategorien (entspricht config.js) ---
KEYWORDS = [
    ('stellplatz', r'übernacht|camper|stellplatz|wohnmobil|camper ?stop|aire de|sosta camper|park4night|rv park'),
    ('camping', r'camping|campground|campsite|camp site|campeggio|glamping'),
    ('aussicht', r'berggipfel|gipfel|gebirgspass|\bpass\b|\bvista\b|landschaftlich schön|\bridge\b|elevated|steilhang|mountain range|bergbahn|seilbahn|\bcapo\b|\bkap\b|aussicht|viewpoint|view point|mirador|belvedere|panorama|lookout|miradouro|point de vue|utsikt'),
    ('strand', r'\bbucht\b|\bcala\b|strand|beach|playa|praia|plage|spiaggia'),
    ('wasser', r'\bfluss\b|\bkanal\b|wasserfall|waterfall|cascada|cascata|cascade|foss\b|see\b|lake|lago|lac\b'),
    ('wandern', r'\bgola\b|wander|wanderweg|hike|hiking|trail|sentiero|sendero|klettersteig|schlucht'),
    ('natur', r'halbinsel|insel|gletscher|vulkan|\bwald\b|\bdune\b|düne|terrain|\bgarten\b|gärten|grotta|grotte|\bisola\b|flamingo|\bpark\b|naturschutz|nationalpark|national park|naturpark|parque natural|gorge|canyon|höhle|cave'),
    ('museum', r'museum|museo|musée|galerie|gallery'),
    ('restaurant', r'steakhaus|gastrokneipe|weinstube|restaurant|ristorante|trattoria|osteria|pizzeria|taverna|bistro|gasthaus|gasthof|wirtshaus|steakhouse|sushi|burger'),
    ('cafe', r'brauerei|biergarten|patisserie|café|cafe|coffee|kaffee|bar\b|pub\b|bakery|bäckerei|gelateria|eis'),
    ('unterkunft', r'bed and breakfast|beherbergung|hotel|hostel|pension|apartment|b&b|guesthouse|lodge|resort|ferienwohnung'),
    ('stadt', r'stadtplatz|\bmarkt\b|promenade|bedeutende straße'),
    ('sehenswuerdigkeit', r'moschee|theater|\bzoo\b|aquarium|rathaus|nurag|nuraxi|murales|sehenswürdigkeit|touristenattraktion|historisch|wahrzeichen|burg|schloss|castle|castillo|castello|château|kirche|dom\b|kathedrale|cathedral|church|basilica|kloster|abbey|monastery|tempel|temple|palast|palace|palazzo|tower|turm|brücke|bridge|ruine|ruins|denkmal|monument|leuchtturm|lighthouse|altstadt|old town|piazza|plaza'),
]
KEYWORDS = [(c, re.compile(p, re.I)) for c, p in KEYWORDS]
OSM_MAP = {
    'tourism:camp_site': 'camping', 'tourism:caravan_site': 'stellplatz', 'tourism:viewpoint': 'aussicht', 'natural:peak': 'aussicht',
    'tourism:attraction': 'sehenswuerdigkeit', 'historic:*': 'sehenswuerdigkeit', 'tourism:artwork': 'sehenswuerdigkeit',
    'amenity:place_of_worship': 'sehenswuerdigkeit', 'man_made:lighthouse': 'sehenswuerdigkeit', 'man_made:tower': 'sehenswuerdigkeit',
    'tourism:theme_park': 'sehenswuerdigkeit', 'tourism:museum': 'museum', 'tourism:gallery': 'museum',
    'amenity:restaurant': 'restaurant', 'amenity:fast_food': 'restaurant', 'amenity:food_court': 'restaurant',
    'amenity:cafe': 'cafe', 'amenity:bar': 'cafe', 'amenity:pub': 'cafe', 'amenity:biergarten': 'cafe', 'amenity:ice_cream': 'cafe',
    'natural:beach': 'strand', 'leisure:beach_resort': 'strand', 'waterway:waterfall': 'wasser', 'natural:water': 'wasser',
    'natural:spring': 'wasser', 'leisure:nature_reserve': 'natur', 'boundary:national_park': 'natur', 'boundary:protected_area': 'natur',
    'leisure:park': 'natur', 'natural:cave_entrance': 'natur', 'natural:glacier': 'natur', 'natural:wood': 'natur',
    'tourism:hotel': 'unterkunft', 'tourism:hostel': 'unterkunft', 'tourism:guest_house': 'unterkunft', 'tourism:apartment': 'unterkunft',
    'tourism:chalet': 'unterkunft', 'place:city': 'stadt', 'place:town': 'stadt', 'place:village': 'stadt', 'place:hamlet': 'stadt',
    'boundary:administrative': 'stadt',
}


def guess_category(name, osm_class=None, osm_type=None, google_cats=None, hint=None):
    for gc in google_cats or []:
        for cat, rx in KEYWORDS:
            if rx.search(gc or ''):
                return cat
    for cat, rx in KEYWORDS:
        if rx.search(name or ''):
            return cat
    for cat, rx in KEYWORDS:
        if rx.search(hint or ''):
            return cat
    if osm_class:
        return OSM_MAP.get(f'{osm_class}:{osm_type}') or OSM_MAP.get(f'{osm_class}:*') or 'sonstiges'
    return 'sonstiges'


# --- Netzwerk mit Cache und Rate-Limit ---
try:
    CACHE = json.load(open(CACHE_FILE, encoding='utf-8'))
except Exception:
    CACHE = {}
_last = {'google': 0.0, 'nominatim': 0.0}


def save_cache():
    json.dump(CACHE, open(CACHE_FILE, 'w', encoding='utf-8'), ensure_ascii=False)


def http_get(url, headers, kind, pause):
    wait = _last[kind] + pause - time.time()
    if wait > 0:
        time.sleep(wait)
    _last[kind] = time.time()
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode('utf-8', 'ignore')


def coords_from_url(url):
    if not url:
        return None
    for pat in (r'!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)', r'@(-?\d+\.\d+),(-?\d+\.\d+)', r'[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)', r'/search/(-?\d+\.\d+),\+?(-?\d+\.\d+)'):
        m = re.search(pat, urllib.parse.unquote(url))
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if abs(lat) > 0.0001 or abs(lng) > 0.0001:
                return lat, lng
    return None


def google_place(url):
    """Fragt die Google-Ortsdaten zum gespeicherten Link ab: Koordinaten, Google-Kategorien, Adresse."""
    if not url or 'google' not in url:
        return None
    key = 'g2:' + url
    if key in CACHE:
        return CACHE[key]
    result = None
    try:
        page = http_get(url.replace('http://', 'https://'), GOOGLE_HEADERS, 'google', 0.8)
        m = re.search(r'href="(/maps/preview/place\?[^"]+)"', page)
        if m:
            raw = http_get('https://www.google.com' + html.unescape(m.group(1)), GOOGLE_HEADERS, 'google', 0.8)
            info = {}
            try:
                p = json.loads(raw[raw.index('\n') + 1:])[6]
                if p[9] and p[9][2] is not None:
                    info = {'lat': p[9][2], 'lng': p[9][3]}
                info['cats'] = p[13] or []
                info['address'] = p[39] if len(p) > 39 and isinstance(p[39], str) else ''
            except Exception:
                pass
            if 'lat' not in info:
                mm = re.search(r'\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]', raw)
                if mm:
                    info.update({'lat': float(mm.group(1)), 'lng': float(mm.group(2))})
            result = info or None
    except Exception as e:
        print(f'    Google-Abfrage fehlgeschlagen: {e}', file=sys.stderr)
        return None  # Netzwerkfehler nicht zwischenspeichern, beim nächsten Lauf erneut versuchen
    CACHE[key] = result
    save_cache()
    return result


def nominatim_search(q):
    key = 's:' + q
    if key in CACHE:
        return CACHE[key]
    res = None
    try:
        url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({'q': q, 'format': 'jsonv2', 'limit': 1, 'addressdetails': 1, 'accept-language': 'de'})
        data = json.loads(http_get(url, {'User-Agent': UA_NOMINATIM}, 'nominatim', 1.1))
        res = data[0] if data else None
    except Exception as e:
        print(f'    Suche fehlgeschlagen: {e}', file=sys.stderr)
        return None
    CACHE[key] = res
    save_cache()
    return res


def nominatim_reverse(lat, lng):
    key = f'r:{lat:.5f},{lng:.5f}'
    if key in CACHE:
        return CACHE[key]
    res = None
    try:
        url = 'https://nominatim.openstreetmap.org/reverse?' + urllib.parse.urlencode({'lat': lat, 'lon': lng, 'format': 'jsonv2', 'zoom': 18, 'addressdetails': 1, 'accept-language': 'de'})
        res = json.loads(http_get(url, {'User-Agent': UA_NOMINATIM}, 'nominatim', 1.1))
        if 'error' in res:
            res = None
    except Exception as e:
        print(f'    Rückwärtssuche fehlgeschlagen: {e}', file=sys.stderr)
        return None
    CACHE[key] = res
    save_cache()
    return res


# --- Takeout einlesen ---
def norm_key(d):
    return {(k or '').strip().lower(): (v or '').strip() for k, v in d.items() if isinstance(k, str) and isinstance(v, (str, type(None)))}


def read_csv(path):
    list_name = os.path.splitext(os.path.basename(path))[0]
    items = []
    with open(path, encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            r = norm_key(row)
            title = r.get('titel') or r.get('title') or ''
            url = r.get('url') or ''
            if not title and not url:
                continue
            note = '\n'.join(x for x in (r.get('notiz') or r.get('note'), r.get('kommentar') or r.get('comment')) if x)
            items.append({'name': title, 'url': url, 'note': note, 'list': list_name})
    return items


def read_geojson(path):
    try:
        data = json.load(open(path, encoding='utf-8'))
    except Exception:
        return []
    if not isinstance(data, dict) or data.get('type') != 'FeatureCollection':
        return []
    list_name = 'Bewertet' if os.path.basename(path).lower() in REVIEW_FILES else 'Markierte Orte'
    items = []
    for f in data.get('features', []):
        p = f.get('properties') or {}
        loc = p.get('location') or p.get('Location') or {}
        name = loc.get('name') or loc.get('Business Name') or p.get('Title') or loc.get('address') or ''
        url = p.get('google_maps_url') or p.get('Google Maps URL') or ''
        coords = (f.get('geometry') or {}).get('coordinates') or [0, 0]
        lat, lng = (coords[1], coords[0]) if len(coords) >= 2 else (0, 0)
        geo = loc.get('Geo Coordinates') or {}
        if (not lat and not lng) and geo:
            lat, lng = float(geo.get('Latitude') or 0), float(geo.get('Longitude') or 0)
        items.append({
            'name': name, 'url': url, 'note': p.get('Comment') or '', 'list': list_name,
            'address': loc.get('address') or loc.get('Address') or '',
            'country': (loc.get('country_code') or loc.get('Country Code') or '').lower() or None,
            'lat': lat if (lat or lng) else None, 'lng': lng if (lat or lng) else None,
        })
    return items


def read_kml_text(text, list_name):
    items = []
    text = re.sub(r'\sxmlns(:\w+)?="[^"]+"', '', text, count=0)
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return items

    def walk(node, folder):
        for child in node:
            if child.tag == 'Folder':
                walk(child, (child.findtext('name') or '').strip() or folder)
            elif child.tag == 'Placemark':
                name = (child.findtext('name') or '').strip()
                desc = re.sub(r'<[^>]+>', ' ', child.findtext('description') or '').strip()
                c = child.find('.//Point/coordinates')
                if c is None or not (c.text or '').strip():
                    continue
                lng, lat = [float(x) for x in c.text.strip().split(',')[:2]]
                items.append({'name': name, 'url': '', 'note': desc, 'list': list_name, 'lat': lat, 'lng': lng, 'hint': folder})
            else:
                walk(child, folder)
    walk(root, '')
    return items


EXCLUDE = []
SAVED_DIRS = ('gespeichert', 'saved')
STARRED_FILES = ('gespeicherte orte.json', 'saved places.json')
REVIEW_FILES = ('bewertungen.json', 'reviews.json')
MYMAPS_DIRS = ('my maps', 'meine karten')


def wanted(path, folder, only, with_reviews):
    rel = os.path.relpath(path, folder)
    parts = [x.lower() for x in rel.split(os.sep)]
    low = parts[-1]
    if only and not any(o.lower() in rel.lower() for o in only):
        return False
    if EXCLUDE and any(x.lower() in rel.lower() for x in EXCLUDE):
        return False
    if low.endswith('.csv'):
        return any(d in parts[:-1] for d in SAVED_DIRS)
    if low in STARRED_FILES:
        return True
    if low in REVIEW_FILES:
        return with_reviews
    if low.endswith(('.kml', '.kmz')):
        return any(d in parts[:-1] for d in MYMAPS_DIRS) or not any(d in parts for d in ('maps',))
    return False


def read_takeout(folder, only=None, with_reviews=False):
    items = []
    for dirpath, _, files in os.walk(folder):
        for fn in sorted(files):
            path = os.path.join(dirpath, fn)
            low = fn.lower()
            if not wanted(path, folder, only, with_reviews):
                continue
            if low.endswith('.csv'):
                got = read_csv(path)
            elif low.endswith('.json') or low.endswith('.geojson'):
                got = read_geojson(path)
            elif low.endswith('.kml'):
                got = read_kml_text(open(path, encoding='utf-8', errors='ignore').read(), os.path.splitext(fn)[0])
            elif low.endswith('.kmz'):
                got = []
                with zipfile.ZipFile(path) as z:
                    for n in z.namelist():
                        if n.lower().endswith('.kml'):
                            got += read_kml_text(z.read(n).decode('utf-8', 'ignore'), os.path.splitext(fn)[0])
            else:
                continue
            if got:
                print(f'  {os.path.relpath(path, folder)}: {len(got)} Einträge')
            items += got
    return items


# --- Zusammenführen ---
def google_key(url):
    if not url:
        return None
    u = urllib.parse.unquote(url)
    m = re.search(r'(0x[0-9a-f]+:0x[0-9a-f]+)', u, re.I)
    if m:
        return m.group(1).lower()
    m = re.search(r'cid=(\d+)', u)
    if m:
        return 'cid:' + m.group(1)
    m = re.search(r'/place/([^/]+)', u)
    if m:
        return 'place:' + m.group(1).lower()
    return u


def dist_m(a, b):
    if a.get('lat') is None or b.get('lat') is None:
        return 1e12
    dlat = math.radians(b['lat'] - a['lat'])
    dlng = math.radians(b['lng'] - a['lng']) * math.cos(math.radians(a['lat']))
    return 6371000 * math.hypot(dlat, dlng)


def stable_id(prefix, s):
    return prefix + hashlib.sha1(s.encode('utf-8')).hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('takeout')
    ap.add_argument('--existing', help='vorhandene places.json (wird ergänzt)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', nargs='*', help='nur Dateien, deren Pfad einen dieser Texte enthält')
    ap.add_argument('--exclude', nargs='*', default=[], help='Dateien auslassen, deren Pfad einen dieser Texte enthält')
    ap.add_argument('--with-reviews', action='store_true', help='auch bewertete Orte importieren')
    ap.add_argument('--fast', action='store_true', help='Google nur abfragen, wenn Koordinaten fehlen')
    ap.add_argument('--no-lists-as-trips', action='store_true', help='Listen nicht als Trips anlegen')
    args = ap.parse_args()

    data = {'version': 1, 'trips': [], 'places': []}
    if args.existing and os.path.exists(args.existing):
        data = json.load(open(args.existing, encoding='utf-8'))
    now = int(time.time() * 1000)
    trips = {t['id']: t for t in data.get('trips', [])}
    places = {p['id']: p for p in data.get('places', [])}
    live = [p for p in places.values() if not p.get('deleted')]

    print('Lese Takeout …')
    EXCLUDE.extend(args.exclude)
    raw = read_takeout(args.takeout, args.only, args.with_reviews)
    if not raw:
        print('Keine Orte gefunden. Stimmt der Ordner?')
        sys.exit(1)

    # gleiche Orte aus mehreren Listen zusammenfassen
    merged = {}
    for it in raw:
        k = google_key(it['url']) or ('n:' + it['name'].lower() + f":{it.get('lat')},{it.get('lng')}")
        if k in merged:
            m = merged[k]
            m['lists'].add(it['list'])
            if it.get('note') and it['note'] not in (m.get('note') or ''):
                m['note'] = '\n'.join(x for x in (m.get('note'), it['note']) if x)
            for f in ('lat', 'lng', 'address', 'country'):
                if m.get(f) is None and it.get(f) is not None:
                    m[f] = it[f]
        else:
            merged[k] = {**it, 'lists': {it['list']}, 'gkey': k}
    print(f'{len(raw)} Einträge, {len(merged)} verschiedene Orte.')

    def trip_for(list_name):
        for t in trips.values():
            if not t.get('deleted') and t.get('name', '').lower() == list_name.lower():
                return t['id']
        tid = stable_id('t', list_name)
        trips[tid] = {'id': tid, 'name': list_name, 'color': TRIP_COLORS[len(trips) % len(TRIP_COLORS)], 'createdAt': now, 'updatedAt': now}
        return tid

    added = updated = nopos = 0
    for i, it in enumerate(merged.values(), 1):
        name = it['name'] or '(ohne Namen)'
        print(f'[{i}/{len(merged)}] {name}', flush=True)
        trip_ids = [] if args.no_lists_as_trips else [trip_for(l) for l in sorted(it['lists'])]

        # Schon vorhanden?
        existing = next((p for p in live if p.get('gkey') and p.get('gkey') == it['gkey']), None)
        if not existing and it.get('lat') is not None:
            existing = next((p for p in live if p.get('name', '').lower() == name.lower() and dist_m(p, it) < 150), None)
        if existing:
            new_trips = [t for t in trip_ids if t not in (existing.get('tripIds') or [])]
            if new_trips:
                existing['tripIds'] = (existing.get('tripIds') or []) + new_trips
                existing['updatedAt'] = now
                updated += 1
            continue

        lat, lng = it.get('lat'), it.get('lng')
        g = None
        if lat is None:
            c = coords_from_url(it['url'])
            if c:
                lat, lng = c
        if it['url'] and 'google' in it['url'] and (lat is None or not args.fast):
            g = google_place(it['url'])
            if g and g.get('lat') is not None and lat is None:
                lat, lng = g['lat'], g['lng']
        osm = None
        if lat is None and it['name']:
            osm = nominatim_search(it['name'])
            if osm:
                lat, lng = float(osm['lat']), float(osm['lon'])
                print('    Position über OpenStreetMap-Suche (bitte prüfen)')
        if lat is not None and not osm:
            osm = nominatim_reverse(lat, lng)
            if osm and osm.get('category') in ('amenity', 'highway', 'shop', 'building'):
                osm = {**osm, 'category': None, 'type': None}
        addr = (osm or {}).get('address') or {}
        country = it.get('country') or (addr.get('country_code') or '').lower() or None
        category = guess_category(name, (osm or {}).get('category'), (osm or {}).get('type'), (g or {}).get('cats'), it.get('hint'))
        if category == 'sonstiges' and g and g.get('lat') is not None and not g.get('cats'):
            category = 'stadt'  # Google liefert für Städte, Orte und Straßen keine Kategorie
        place = {
            'id': stable_id('p', it['gkey']),
            'name': name,
            'lat': lat, 'lng': lng,
            'country': country,
            'city': addr.get('city') or addr.get('town') or addr.get('village') or addr.get('municipality') or '',
            'address': it.get('address') or (g or {}).get('address') or (osm or {}).get('display_name') or '',
            'category': category,
            'tripIds': trip_ids,
            'note': it.get('note') or '',
            'visited': False, 'visitedDate': None,
            'googleUrl': it['url'] or None,
            'gkey': it['gkey'],
            'source': 'takeout',
            'createdAt': now, 'updatedAt': now,
        }
        places[place['id']] = place
        live.append(place)
        added += 1
        if lat is None:
            nopos += 1
            print('    Keine Position gefunden')

    data['trips'] = sorted(trips.values(), key=lambda t: t.get('name', ''))
    data['places'] = sorted(places.values(), key=lambda p: p.get('name', ''))
    data['updatedAt'] = now
    json.dump(data, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'\nFertig: {added} neu, {updated} ergänzt, {nopos} ohne Position. Gespeichert in {args.out}')


if __name__ == '__main__':
    main()
