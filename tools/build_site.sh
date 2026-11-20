#!/bin/sh
# Builds the static website: dist/site (upload this folder to any static host) and dist/toycity-site.zip.
# Only the game page, its scripts, the models and the Barendrecht region go in; development pages,
# test regions and the old prototype stay out. three.js and Leaflet still load from their public CDNs.
# Usage: sh tools/build_site.sh
set -e
cd "$(dirname "$0")/.."
OUT=dist/site
rm -rf "$OUT" dist/toycity-site.zip
mkdir -p "$OUT/models" "$OUT/regions/barendrecht" "$OUT/mp"
cp web/city.html "$OUT/index.html"
cp web/city.html web/city.js web/loader.worker.js web/textures.js web/avatar.js "$OUT/"
cp web/mp/*.js "$OUT/mp/"
cp web/models/cars.glb web/models/person.glb web/models/persona_*.glb web/models/CREDITS.txt "$OUT/models/"
cp -R web/regions/barendrecht/tiles.json web/regions/barendrecht/search.json \
      web/regions/barendrecht/t web/regions/barendrecht/a web/regions/barendrecht/o "$OUT/regions/barendrecht/"
# cache rules for Netlify and Cloudflare Pages (other hosts ignore this file): the region index is
# always revalidated because it carries the build stamp; everything else may be cached for a day
cat > "$OUT/_headers" <<'H'
/*
  Cache-Control: public, max-age=86400
/regions/*/tiles.json
  Cache-Control: no-cache
/*.html
  Cache-Control: no-cache
/*.js
  Cache-Control: no-cache
/mp/*
  Cache-Control: no-cache
H
(cd dist && zip -qr toycity-site.zip site)
du -sh "$OUT" dist/toycity-site.zip
