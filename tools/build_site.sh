#!/bin/sh
# Builds the static website: dist/site (upload this folder to any static host) and dist/toycity-site.zip.
# Only the front page, the game page, its scripts, the models and the regions that web/places.json
# uses go in (REGIONS="a b" overrides the list); development pages, test regions and the old
# prototype stay out. three.js and Leaflet still load from their public CDNs.
# Usage: sh tools/build_site.sh          REGIONS=barendrecht sh tools/build_site.sh          ZIP=1 for the zip
set -e
cd "$(dirname "$0")/.."
OUT=dist/site
RS=${REGIONS:-$(python3 -c "import json; print(' '.join(dict.fromkeys(p['region'] for p in json.load(open('web/places.json')))))")}
rm -rf "$OUT" dist/toycity-site.zip
mkdir -p "$OUT/models" "$OUT/mp" "$OUT/media"
cp web/index.html web/places.json "$OUT/"   # the front page: choose a place
cp web/media/* "$OUT/media/"
cp web/city.html web/city.js web/loader.worker.js web/textures.js web/avatar.js web/solids.js web/vehicle.js "$OUT/"
cp web/mp/*.js "$OUT/mp/"
cp web/models/cars.glb web/models/person.glb web/models/persona_*.glb web/models/CREDITS.txt "$OUT/models/"
for R in $RS; do
  mkdir -p "$OUT/regions/$R"
  cp -R web/regions/$R/tiles.json web/regions/$R/search.json \
        web/regions/$R/t web/regions/$R/a web/regions/$R/o "$OUT/regions/$R/"
done
echo "regions: $RS"
# cache rules for Netlify and Cloudflare Pages (other hosts ignore this file): the region index is
# always revalidated because it carries the build stamp; everything else may be cached for a day
cat > "$OUT/_headers" <<'H'
/*
  Cache-Control: public, max-age=86400
/regions/*/tiles.json
  Cache-Control: no-cache
/places.json
  Cache-Control: no-cache
/
  Cache-Control: no-cache
/*.html
  Cache-Control: no-cache
/*.js
  Cache-Control: no-cache
/mp/*
  Cache-Control: no-cache
H
[ -n "$ZIP" ] && (cd dist && zip -qr toycity-site.zip site)
du -sh "$OUT"; find "$OUT" -type f | wc -l
