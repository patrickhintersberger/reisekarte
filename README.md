# Reisekarte

Eigene Karte im Google-Maps-Stil für Sehenswürdigkeiten, Campingplätze, Restaurants, Aussichtspunkte und mehr. Jede Kategorie hat ihr eigenes Icon, jeder Punkt zeigt die Flagge seines Landes, und erledigte Punkte bekommen ein ✅. Punkte lassen sich nach Ländern und Trips ordnen. „Route starten“ öffnet die Navigation in Google Maps.

**App:** https://patrickhintersberger.github.io/reisekarte/

## Daten
Die Punkte liegen im privaten Repo `reisekarte-daten` (Datei `places.json`). Die App liest und schreibt die Datei über die GitHub-API. Dafür braucht jedes Gerät einmal einen Fine-grained Token (Einstellungen in der App → „So bekommst du einen Token“).

## Google-Takeout importieren
1. Auf takeout.google.com nur **„Gespeichert“** und **„Maps (Meine Orte)“** auswählen, exportieren, herunterladen und entpacken.
2. Die aktuellen Daten holen und den Import starten:
   ```bash
   gh repo clone patrickhintersberger/reisekarte-daten _daten
   python3 tools/import_takeout.py ~/Downloads/Takeout --existing _daten/places.json --out _daten/places.json
   cd _daten && git commit -am "Google-Takeout importiert" && git push
   ```
   Jede gespeicherte Liste wird ein Trip. Die Koordinaten kommen aus den Google-Links. Punkte ohne gefundene Position erscheinen in der App unter „Ohne Position“.

## Kategorien anpassen
In `config.js` (`RK_CATEGORIES`). Die Icons sind [Material Symbols](https://fonts.google.com/icons). Ein neues Icon muss zusätzlich in `index.html` in der Liste `icon_names=` stehen (alphabetisch sortiert).
