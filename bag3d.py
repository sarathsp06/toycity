#!/usr/bin/env python3
"""Attach real 3D BAG building shapes (LoD 2.2 roofs) to a baked block.

Usage: bag3d.py BLOCK.json [CACHE.json]
Buildings are matched on their OSM ref:bag id. Matched buildings get
  "m": {"v": [x, y, z, ...], "f": [[i, j, k, ...], ...], "s": [0|1|2, ...]}
in the block's local metres (x east, y north, z up from the building's own
ground level); s is 0 ground, 1 roof, 2 wall. Their "h" becomes the measured
roof height. Unmatched buildings keep the extruded footprint.
"""
import json
import math
import os
import sys
import urllib.request

API = "https://api.3dbag.nl/collections/pand/items"
PAGE = 50


def rd_to_wgs(x, y):
    # Schreutelkamp & Strang van Hees approximation, about 1 m accurate.
    dx, dy = (x - 155000) * 1e-5, (y - 463000) * 1e-5
    n = (3235.65389 * dy - 32.58297 * dx**2 - 0.2475 * dy**2 - 0.84978 * dx**2 * dy
         - 0.0655 * dy**3 - 0.01709 * dx**2 * dy**2 - 0.00738 * dx + 0.0053 * dx**4
         - 0.00039 * dx**2 * dy**3 + 0.00033 * dx**4 * dy - 0.00012 * dx * dy)
    e = (5260.52916 * dx + 105.94684 * dx * dy + 2.45656 * dx * dy**2 - 0.81885 * dx**3
         + 0.05594 * dx * dy**3 - 0.05607 * dx**3 * dy + 0.01199 * dy - 0.00256 * dx**3 * dy**2
         + 0.00128 * dx * dy**4 + 0.00022 * dy**2 - 0.00022 * dx**2 + 0.00026 * dx**5)
    return 52.15517440 + n / 3600, 5.38720621 + e / 3600


def wgs_to_rd(lat, lon):
    x, y = 155000.0, 463000.0
    for _ in range(20):
        la, lo = rd_to_wgs(x, y)
        x += (lon - lo) * 111320 * math.cos(math.radians(lat))
        y += (lat - la) * 111320
    return x, y


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "toycity-proto/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_all(bbox):
    # Each page carries its own vertex transform, so keep it with its features.
    # Paging follows the server's next links; its offsets are not plain multiples of the limit.
    url = f"{API}?bbox={bbox[0]:.1f},{bbox[1]:.1f},{bbox[2]:.1f},{bbox[3]:.1f}&limit={PAGE}"
    feats, seen = [], set()
    while url:
        page = fetch(url)
        tf = page["metadata"]["transform"]
        for f in page["features"]:
            if f["id"] not in seen:
                seen.add(f["id"])
                f["transform"] = tf
                feats.append(f)
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
        x0, y0 = wgs_to_rd(lat0 - dl, lon0 - dn)
        x1, y1 = wgs_to_rd(lat0 + dl, lon0 + dn)
        feats = fetch_all((min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))
        print("3dbag features", len(feats))
        if cache:
            json.dump(feats, open(cache, "w"))

    sem_code = {"GroundSurface": 0, "RoofSurface": 1}

    shapes = {}
    for f in feats:
        verts = f["vertices"]
        sc, tr = f["transform"]["scale"], f["transform"]["translate"]
        attrs = {}
        for oid, obj in f["CityObjects"].items():
            if obj["type"] == "Building":
                attrs = obj.get("attributes", {})
                bag_id = oid.rsplit(".", 1)[-1].lstrip("0")
        ground = attrs.get("b3_h_maaiveld") or 0.0
        local = {}
        faces, sems = [], []
        for obj in f["CityObjects"].values():
            if obj["type"] != "BuildingPart":
                continue
            geo = next((g for g in obj.get("geometry", []) if g["lod"] == "2.2"), None)
            if not geo:
                continue
            sem = geo.get("semantics", {})
            stypes = [s["type"] for s in sem.get("surfaces", [])]
            for shell_i, shell in enumerate(geo["boundaries"]):
                svals = sem.get("values", [[]])[shell_i] if sem else []
                for face_i, face in enumerate(shell):
                    ring = face[0]  # outer ring only; LoD 2.2 faces rarely have holes
                    for vi in ring:
                        if vi not in local:
                            local[vi] = len(local)
                    faces.append([local[vi] for vi in ring])
                    sv = svals[face_i] if face_i < len(svals) else None
                    sems.append(sem_code.get(stypes[sv], 2) if sv is not None else 2)
        if not faces:
            continue
        out = [0.0] * (3 * len(local))
        for vi, li in local.items():
            vx, vy, vz = verts[vi]
            rx, ry, rz = vx * sc[0] + tr[0], vy * sc[1] + tr[1], vz * sc[2] + tr[2]
            la, lo = rd_to_wgs(rx, ry)
            out[3 * li] = round((lo - lon0) * kx, 2)
            out[3 * li + 1] = round((la - lat0) * ky, 2)
            out[3 * li + 2] = round(rz - ground, 2)
        shapes[bag_id] = {"v": out, "f": faces, "s": sems,
                          "h": round((attrs.get("b3_h_dak_max") or ground) - ground, 2),
                          "roof": attrs.get("b3_dak_type"),
                          "year": attrs.get("oorspronkelijkbouwjaar")}

    matched = 0
    for b in block["buildings"]:
        s = shapes.get((b.get("bag") or "").lstrip("0"))
        if not s:
            continue
        matched += 1
        b["m"] = {"v": s["v"], "f": s["f"], "s": s["s"]}
        if s["h"] > 0.5:
            b["h"] = s["h"]
        b["roof"] = s["roof"]
        if s["year"]:
            b["year"] = s["year"]
    print("buildings", len(block["buildings"]), "with 3D BAG shape", matched)
    json.dump(block, open(path, "w"), separators=(",", ":"))


if __name__ == "__main__":
    main()
