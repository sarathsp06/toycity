#!/usr/bin/env python3
"""Bake a high-detail zone from the Dutch BGT into a block: every road, pavement,
parking bay, garden and verge surface, plus hedges, individual trees and lamp posts.

Usage: detail_bgt.py BLOCK.json LAT LON RADIUS_M [CACHE.json]
Adds block["detail"] = {"c": [x, y], "r": radius, "surfaces": [...], "hedges": [...],
"trees": [[x, y], ...], "lamps": [[x, y], ...], "play": [[x, y], ...]} in local metres.
Surface "k" is one of: road, brickroad, parking, pavement, cycle, kerbisland, verge, grass, plants,
yard, sand, paved.
"""
import json
import math
import os
import sys
import urllib.request

API = "https://api.pdok.nl/kadaster/bgt/ogc/v1/collections/{}/items"
LAYERS = ["wegdeel", "ondersteunendwegdeel", "begroeidterreindeel", "onbegroeidterreindeel",
          "vegetatieobject_punt", "vegetatieobject_vlak", "paal", "straatmeubilair", "scheiding_vlak"]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "toycity-proto/0.1"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def fetch_layer(layer, bbox):
    url = API.format(layer) + f"?bbox={bbox[0]:.6f},{bbox[1]:.6f},{bbox[2]:.6f},{bbox[3]:.6f}&limit=1000&f=json"
    feats = []
    while url:
        page = fetch(url)
        feats += page["features"]
        url = next((l["href"] for l in page["links"] if l["rel"] == "next"), None)
        if not page["features"]:
            break
    return [f for f in feats if not f["properties"].get("eind_registratie") and f.get("geometry")]


def surface_kind(layer, p):
    look = (p.get("plus_fysiek_voorkomen") or "") + " " + (p.get("fysiek_voorkomen") or "")
    if layer == "wegdeel":
        fn = p.get("functie") or ""
        if "parkeer" in fn:
            return "parking"
        if "fiets" in fn:
            return "cycle"
        if "rijbaan" in fn or "inrit" in fn:
            return "road" if "asfalt" in look or "gesloten" in look else "brickroad"
        return "pavement"
    if layer == "ondersteunendwegdeel":
        return "kerbisland" if "eiland" in (p.get("functie") or "") else "verge"
    if layer == "begroeidterreindeel":
        if any(w in look for w in ("struik", "heester", "bodembedek", "rozen", "haag")):
            return "plants"
        return "grass"
    if "zand" in look:
        return "sand"
    if "erf" in look:
        return "yard"
    return "paved"


def main():
    path, lat, lon, radius = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    cache = sys.argv[5] if len(sys.argv) > 5 else None
    block = json.load(open(path))
    lat0, lon0 = block["center"]["lat"], block["center"]["lon"]
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 111_320.0

    if cache and os.path.exists(cache):
        layers = json.load(open(cache))
    else:
        dl, dn = (radius + 20) / ky, (radius + 20) / (111_320.0 * math.cos(math.radians(lat)))
        bbox = (lon - dn, lat - dl, lon + dn, lat + dl)
        layers = {l: fetch_layer(l, bbox) for l in LAYERS}
        if cache:
            json.dump(layers, open(cache, "w"))

    def xy(c):
        return [round((c[0] - lon0) * kx, 2), round((c[1] - lat0) * ky, 2)]

    def polys(g):
        if g["type"] == "Polygon":
            return [g["coordinates"]]
        if g["type"] == "MultiPolygon":
            return g["coordinates"]
        return []

    det = {"c": xy([lon, lat]), "r": radius, "surfaces": [], "hedges": [], "walls": [],
           "trees": [], "lamps": [], "play": []}
    for layer, feats in layers.items():
        for f in feats:
            p, g = f["properties"], f["geometry"]
            if p.get("relatieve_hoogteligging", 0) not in (0, None):
                continue  # skip things on bridges or underground
            if g["type"] == "Point":
                pt = xy(g["coordinates"])
                kind = p.get("plus_type") or ""
                if layer == "vegetatieobject_punt":
                    det["trees"].append(pt)
                elif layer == "paal" and "licht" in kind:
                    det["lamps"].append(pt)
                elif layer == "straatmeubilair" and "speel" in kind:
                    det["play"].append(pt)
                continue
            for poly in polys(g):
                rec = {"p": [xy(c) for c in poly[0]], "holes": [[xy(c) for c in h] for h in poly[1:]]}
                if layer == "vegetatieobject_vlak":
                    det["hedges"].append(rec)
                elif layer == "scheiding_vlak":
                    det["walls"].append(rec)
                elif layer in ("wegdeel", "ondersteunendwegdeel", "begroeidterreindeel", "onbegroeidterreindeel"):
                    rec["k"] = surface_kind(layer, p)
                    det["surfaces"].append(rec)
    block["detail"] = det
    print({k: len(v) for k, v in det.items() if isinstance(v, list)})
    json.dump(block, open(path, "w"), separators=(",", ":"))


if __name__ == "__main__":
    main()
