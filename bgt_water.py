#!/usr/bin/env python3
"""Add the official Dutch BGT water parts (waterdeel) to a baked block's water.

Usage: bgt_water.py BLOCK.json [CACHE.json]
OpenStreetMap misses many Dutch ditches and canal stretches; BGT maps every one.
Only current features (no eind_registratie) are used. OSM water is kept too, since BGT
splits some ponds differently; the two overlap harmlessly when drawn.
"""
import json
import math
import os
import sys
import urllib.request

API = "https://api.pdok.nl/kadaster/bgt/ogc/v1/collections/waterdeel/items"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "toycity-proto/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_all(bbox):
    url = f"{API}?bbox={bbox[0]:.6f},{bbox[1]:.6f},{bbox[2]:.6f},{bbox[3]:.6f}&limit=1000&f=json"
    feats = []
    while url:
        page = fetch(url)
        feats += page["features"]
        url = next((l["href"] for l in page["links"] if l["rel"] == "next"), None)
        if not page["features"]:
            break
    return feats


def main():
    path = sys.argv[1]
    cache = sys.argv[2] if len(sys.argv) > 2 else None
    block = json.load(open(path))
    lat0, lon0, half = block["center"]["lat"], block["center"]["lon"], block["half"]
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 111_320.0

    if cache and os.path.exists(cache):
        feats = json.load(open(cache))
    else:
        dl, dn = (half + 30) / ky, (half + 30) / kx
        feats = fetch_all((lon0 - dn, lat0 - dl, lon0 + dn, lat0 + dl))
        if cache:
            json.dump(feats, open(cache, "w"))

    def local(ring):
        return [[round((lo - lon0) * kx, 2), round((la - lat0) * ky, 2)] for lo, la in ring]

    water = []
    for f in feats:
        p, g = f["properties"], f["geometry"]
        if p.get("eind_registratie") or not g:
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []
        for poly in polys:
            water.append({"p": local(poly[0]), "holes": [local(h) for h in poly[1:]], "kind": p.get("plus_type") or p.get("type")})
    print("bgt water features", len(feats), "polygons", len(water), "(osm had", len(block["water"]), ")")
    block["water"] = [w for w in block["water"] if w.get("kind") is None] + water
    json.dump(block, open(path, "w"), separators=(",", ":"))


if __name__ == "__main__":
    main()
