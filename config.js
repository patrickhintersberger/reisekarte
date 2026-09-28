// Grundeinstellungen der Reisekarte.
// Kategorien lassen sich hier beliebig ergänzen: id (eindeutig), name, icon (Material Symbols), color.
window.RK_CONFIG = {
  owner: 'patrickhintersberger',
  dataRepo: 'reisekarte-daten',
  dataPath: 'places.json',
  branch: 'main',
  // Schnelle Live-Suche (Geoapify, Gratis-Plan). Der Schlüssel ist auf die Reisekarten-Adresse beschränkt.
  geoapifyKey: '6deece52a3484a56bf82283b8d70f588',
};

window.RK_CATEGORIES = [
  { id: 'sehenswuerdigkeit', name: 'Sehenswürdigkeit', plural: 'Sehenswürdigkeiten', icon: 'museum',          color: '#7B4FD6' },
  { id: 'camping',           name: 'Campingplatz',     plural: 'Camping',            icon: 'camping',         color: '#2E8B3E' },
  { id: 'restaurant',        name: 'Restaurant',       plural: 'Restaurants',        icon: 'restaurant',      color: '#E8710A' },
  { id: 'aussicht',          name: 'Aussichtspunkt',   plural: 'Aussichtspunkte',    icon: 'landscape',       color: '#0F9D9A' },
  { id: 'strand',            name: 'Strand',           plural: 'Strände',            icon: 'beach_access',    color: '#1FA5E0' },
  { id: 'wandern',           name: 'Wanderung',        plural: 'Wanderungen',        icon: 'hiking',          color: '#3D6B35' },
  { id: 'natur',             name: 'Natur & Nationalpark', plural: 'Natur',          icon: 'park',            color: '#6B8E23' },
  { id: 'wasser',            name: 'Wasserfall & See', plural: 'Wasserfälle & Seen', icon: 'water',           color: '#1A73E8' },
  { id: 'unterkunft',        name: 'Unterkunft',       plural: 'Unterkünfte',        icon: 'hotel',           color: '#D63F8C' },
  { id: 'stellplatz',        name: 'Wohnmobil-Stellplatz', plural: 'Stellplätze',    icon: 'rv_hookup',       color: '#7A7A2E' },
  { id: 'cafe',              name: 'Café & Bar',       plural: 'Cafés & Bars',       icon: 'local_cafe',      color: '#8D5B3E' },
  { id: 'museum',            name: 'Museum',           plural: 'Museen',             icon: 'account_balance', color: '#546E8A' },
  { id: 'stadt',             name: 'Stadt & Ort',      plural: 'Städte',             icon: 'location_city',   color: '#5F6B7A' },
  { id: 'sonstiges',         name: 'Sonstiges',        plural: 'Sonstiges',          icon: 'place',           color: '#D93025' },
];

// Zuordnung von OpenStreetMap-Typen zu Kategorien (für Suche und Import).
window.RK_OSM_MAP = {
  'tourism:camp_site': 'camping', 'tourism:caravan_site': 'stellplatz',
  'tourism:viewpoint': 'aussicht', 'natural:peak': 'aussicht',
  'tourism:attraction': 'sehenswuerdigkeit', 'historic:*': 'sehenswuerdigkeit', 'tourism:artwork': 'sehenswuerdigkeit',
  'building:cathedral': 'sehenswuerdigkeit', 'building:church': 'sehenswuerdigkeit', 'amenity:place_of_worship': 'sehenswuerdigkeit',
  'man_made:lighthouse': 'sehenswuerdigkeit', 'man_made:tower': 'sehenswuerdigkeit', 'tourism:theme_park': 'sehenswuerdigkeit',
  'tourism:museum': 'museum', 'tourism:gallery': 'museum',
  'amenity:restaurant': 'restaurant', 'amenity:fast_food': 'restaurant', 'amenity:food_court': 'restaurant',
  'amenity:cafe': 'cafe', 'amenity:bar': 'cafe', 'amenity:pub': 'cafe', 'amenity:biergarten': 'cafe', 'amenity:ice_cream': 'cafe',
  'natural:beach': 'strand', 'leisure:beach_resort': 'strand',
  'waterway:waterfall': 'wasser', 'natural:water': 'wasser', 'water:lake': 'wasser', 'natural:spring': 'wasser',
  'leisure:nature_reserve': 'natur', 'boundary:national_park': 'natur', 'boundary:protected_area': 'natur', 'natural:wood': 'natur',
  'leisure:park': 'natur', 'natural:cave_entrance': 'natur', 'natural:glacier': 'natur',
  'highway:path': 'wandern', 'route:hiking': 'wandern', 'highway:footway': 'wandern',
  'tourism:hotel': 'unterkunft', 'tourism:hostel': 'unterkunft', 'tourism:guest_house': 'unterkunft', 'tourism:apartment': 'unterkunft', 'tourism:chalet': 'unterkunft',
  'place:city': 'stadt', 'place:town': 'stadt', 'place:village': 'stadt', 'place:hamlet': 'stadt', 'boundary:administrative': 'stadt',
};

// Stichwörter im Namen, falls der OSM-Typ nichts ergibt.
window.RK_KEYWORDS = [
  ['stellplatz', /stellplatz|wohnmobil|camper ?stop|aire de|sosta camper|park4night|rv park/i],
  ['camping', /camping|campground|campsite|camp site|campeggio|glamping/i],
  ['aussicht', /aussicht|viewpoint|view point|mirador|belvedere|panorama|lookout|miradouro|point de vue|utsikt/i],
  ['strand', /strand|beach|playa|praia|plage|spiaggia/i],
  ['wasser', /wasserfall|waterfall|cascada|cascata|cascade|foss\b|see\b|lake|lago|lac\b/i],
  ['wandern', /wander|wanderweg|hike|hiking|trail|sentiero|sendero|klettersteig|schlucht/i],
  ['natur', /\bpark\b|naturschutz|nationalpark|national park|naturpark|parque natural|gorge|canyon|höhle|cave/i],
  ['museum', /museum|museo|musée|galerie|gallery/i],
  ['restaurant', /restaurant|ristorante|trattoria|osteria|pizzeria|taverna|bistro|gasthaus|gasthof|wirtshaus|steakhouse|sushi|burger/i],
  ['cafe', /café|cafe|coffee|kaffee|bar\b|pub\b|bakery|bäckerei|gelateria|eis/i],
  ['unterkunft', /hotel|hostel|pension|apartment|b&b|guesthouse|lodge|resort|ferienwohnung/i],
  ['sehenswuerdigkeit', /sehenswürdigkeit|touristenattraktion|historisch|wahrzeichen|burg|schloss|castle|castillo|castello|château|kirche|dom\b|kathedrale|cathedral|church|basilica|kloster|abbey|monastery|tempel|temple|palast|palace|palazzo|tower|turm|brücke|bridge|ruine|ruins|denkmal|monument|leuchtturm|lighthouse|altstadt|old town|piazza|plaza/i],
];
