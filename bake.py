#!/usr/bin/env python3
"""Bake one Dutch region for the toy-city page from free open data, in one command.

Usage: bake.py "ADDRESS" [--slug NAME] [--half 450] [--detail 170]
  e.g. bake.py "Schaatsbaan 43, Barendrecht"
       bake.py "Dam 1, Amsterdam" --slug amsterdam-dam

Steps (all free, no keys):
  1. PDOK Locatieserver   address -> coordinates
  2. OpenStreetMap API    roads, buildings, names, addresses, furniture  (fetch_block.py)
  3. 3D BAG               real building shapes and heights               (bag3d.py)
  4. BGT                  all water                                       (bgt_water.py)
  5. BGT                  street surfaces, trees, lamps, hedges near the address (detail_bgt.py)
  6. PDOK aerial photo    roof imagery near the address                   (aerial.py)
Output: web/regions/<slug>/block.json plus aerial tiles, and an entry in web/regions/index.json.
Open it with index.html?region=<slug>. Raw downloads are cached in data/<slug>/.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LOCATIE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"
OSM_MAP = "https://api.openstreetmap.org/api/0.6/map"


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "toycity-proto/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def geocode(q):
    url = f"{LOCATIE}?q={urllib.parse.quote(q)}&rows=1&fl=weergavenaam,centroide_ll,type"
    docs = json.loads(get(url))["response"]["docs"]
    if not docs:
        raise SystemExit(f"address not found in the Netherlands: {q}")
    lon, lat = map(float, re.findall(r"[-\d.]+", docs[0]["centroide_ll"]))
    return lat, lon, docs[0]["weergavenaam"]


def run(*args):
    print("  $", " ".join(os.path.basename(a) if i == 0 or os.path.isabs(a) else a for i, a in enumerate(args)))
    subprocess.run([sys.executable, "-I", *args], check=True, cwd=HERE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("address")
    ap.add_argument("--slug")
    ap.add_argument("--half", type=float, default=450, help="half size of the whole block in metres")
    ap.add_argument("--detail", type=float, default=170, help="radius of the realistic zone in metres")
    a = ap.parse_args()

    lat, lon, label = geocode(a.address)
    slug = a.slug or re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:48]
    print(f"{label}  ->  {lat:.6f}, {lon:.6f}  ->  {slug}")
    data = os.path.join(HERE, "data", slug)
    out = os.path.join(HERE, "web", "regions", slug)
    os.makedirs(data, exist_ok=True)
    os.makedirs(out, exist_ok=True)
    block = os.path.join(out, "block.json")

    raw = os.path.join(data, "raw.osm")
    if not os.path.exists(raw):
        dl = a.half / 111_320.0
        dn = a.half / (111_320.0 * math.cos(math.radians(lat)))
        print("  downloading OpenStreetMap data")
        open(raw, "wb").write(get(f"{OSM_MAP}?bbox={lon - dn:.5f},{lat - dl:.5f},{lon + dn:.5f},{lat + dl:.5f}", 300))

    run(os.path.join(HERE, "fetch_block.py"), str(lat), str(lon), str(a.half), block, raw)
    run(os.path.join(HERE, "bag3d.py"), block, os.path.join(data, "3dbag.json"))
    run(os.path.join(HERE, "bgt_water.py"), block, os.path.join(data, "bgt-water.json"))
    run(os.path.join(HERE, "detail_bgt.py"), block, str(lat), str(lon), str(a.detail), os.path.join(data, "bgt-detail.json"))
    run(os.path.join(HERE, "aerial.py"), block, os.path.join(out, "aerial"))

    # start the player at the address and record the region's title
    b = json.load(open(block))
    b["title"] = label
    b["start"] = {"label": a.address, "x": b["detail"]["c"][0], "y": b["detail"]["c"][1]}
    json.dump(b, open(block, "w"), separators=(",", ":"))

    index_path = os.path.join(HERE, "web", "regions", "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else []
    index = [r for r in index if r["slug"] != slug] + [{"slug": slug, "title": label, "start": a.address}]
    json.dump(index, open(index_path, "w"), indent=1)
    print(f"done: open index.html?region={slug}")


if __name__ == "__main__":
    main()
