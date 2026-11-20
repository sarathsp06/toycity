#!/usr/bin/env python3
"""Fetch an OpenStreetMap block around a centre point and bake it into a
local-metre JSON file for the toy-city renderer.

Usage: fetch_block.py LAT LON HALF_SIZE_M OUT.json [RAW.osm]
If RAW.osm is given (from api.openstreetmap.org/api/0.6/map), it is parsed instead of querying Overpass.
"""
import json
import math
import sys
import urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"
# OSM point tags drawn as street furniture, mapped to the renderer's furniture kinds
FURNITURE = {
    "barrier=bollard": "bollard", "amenity=waste_basket": "bin", "amenity=bench": "bench",
    "amenity=bicycle_parking": "bikerack", "highway=bus_stop": "busstop", "highway=street_lamp": "lamp",
    "amenity=charging_station": "charger", "amenity=post_box": "postbox",
}


def bbox(lat, lon, half):
    dlat = half / 111_320.0
    dlon = half / (111_320.0 * math.cos(math.radians(lat)))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def query(s, w, n, e):
    return f"""
[out:json][timeout:60];
(
  way["highway"]({s},{w},{n},{e});
  way["building"]({s},{w},{n},{e});
  relation["building"]({s},{w},{n},{e});
  way["natural"="water"]({s},{w},{n},{e});
  way["waterway"]({s},{w},{n},{e});
  relation["natural"="water"]({s},{w},{n},{e});
  way["landuse"~"grass|park|forest|cemetery|allotments|recreation_ground"]({s},{w},{n},{e});
  way["leisure"~"park|pitch|playground|garden"]({s},{w},{n},{e});
  way["railway"~"rail|tram"]({s},{w},{n},{e});
  node["natural"="tree"]({s},{w},{n},{e});
  node["shop"]({s},{w},{n},{e});
  node["amenity"~"cafe|restaurant|bar|pub|fast_food|bakery|pharmacy|bank|school|place_of_worship|library|cinema"]({s},{w},{n},{e});
  way["shop"]({s},{w},{n},{e});
  way["amenity"~"cafe|restaurant|bar|pub|fast_food|school|place_of_worship|library|cinema|townhall"]({s},{w},{n},{e});
);
out body;
>;
out skel qt;
"""



def load_osm_xml(path):
    import xml.etree.ElementTree as ET
    root = ET.parse(path).getroot()
    elements = []
    for el in root:
        if el.tag == "node":
            d = {"type": "node", "id": int(el.get("id")), "lat": float(el.get("lat")), "lon": float(el.get("lon"))}
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tags:
                d["tags"] = tags
            elements.append(d)
        elif el.tag == "way":
            d = {"type": "way", "id": int(el.get("id")), "nodes": [int(n.get("ref")) for n in el.findall("nd")]}
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tags:
                d["tags"] = tags
            elements.append(d)
        elif el.tag == "relation":
            d = {"type": "relation", "id": int(el.get("id")), "members": [{"type": m.get("type"), "ref": int(m.get("ref")), "role": m.get("role")} for m in el.findall("member")]}
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tags:
                d["tags"] = tags
            elements.append(d)
    return {"elements": elements}

def main():
    lat, lon, half = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
    out = sys.argv[4]
    s, w, n, e = bbox(lat, lon, half)
    if len(sys.argv) > 5:
        data = load_osm_xml(sys.argv[5])
    else:
        req = urllib.request.Request(
            OVERPASS,
            data=("data=" + urllib.parse.quote(query(s, w, n, e))).encode(),
            headers={"User-Agent": "toycity-proto/0.1"},
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.load(r)

    nodes = {}
    ways = {}
    rels = []
    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = el
        elif el["type"] == "way":
            ways[el["id"]] = el
        elif el["type"] == "relation":
            rels.append(el)

    kx = 111_320.0 * math.cos(math.radians(lat))
    ky = 111_320.0

    def xy(nid):
        nd = nodes[nid]
        return [round((nd["lon"] - lon) * kx, 2), round((nd["lat"] - lat) * ky, 2)]

    def coords(way):
        return [xy(n) for n in way["nodes"] if n in nodes]

    def height(tags):
        if "height" in tags:
            try:
                return float(str(tags["height"]).replace("m", "").strip())
            except ValueError:
                pass
        if "building:levels" in tags:
            try:
                return float(tags["building:levels"]) * 3.2 + 1.0
            except ValueError:
                pass
        b = tags.get("building", "yes")
        if b in ("house", "detached", "semidetached_house", "terrace", "residential"):
            return 7.5
        if b in ("garage", "garages", "shed", "hut", "roof"):
            return 3.0
        if b in ("church", "cathedral"):
            return 18.0
        if b in ("apartments", "commercial", "retail", "office", "school"):
            return 11.0
        return 8.0

    roads, buildings, water, green, rails, trees, pois, waterways = [], [], [], [], [], [], [], []
    furniture = []
    used_in_rel = set()

    for rel in rels:
        tags = rel.get("tags", {})
        # only area multipolygons own their member ways; route relations (bus lines) and 3D building
        # groupings (type=building) must not hide the roads and buildings they reference
        if tags.get("type") != "multipolygon":
            continue
        outer = []
        inner = []
        for m in rel.get("members", []):
            if m["type"] != "way" or m["ref"] not in ways:
                continue
            # an outer ring of a building or water multipolygon is drawn by the relation;
            # inner rings and members of other multipolygons (squares, landuse) keep their own tags
            if m.get("role") != "inner" and ("building" in tags or tags.get("natural") == "water"):
                used_in_rel.add(m["ref"])
            c = coords(ways[m["ref"]])
            if len(c) < 3:
                continue
            (outer if m.get("role") != "inner" else inner).append(c)
        if not outer:
            continue
        if "building" in tags:
            for o in outer:
                buildings.append({"p": o, "h": height(tags), "holes": inner, "kind": tags.get("building", "yes"), "name": tags.get("name"), "num": tags.get("addr:housenumber"), "street": tags.get("addr:street"), "bag": tags.get("ref:bag")})
        elif tags.get("natural") == "water":
            for o in outer:
                water.append({"p": o, "holes": inner})

    for wid, way in ways.items():
        tags = way.get("tags", {})
        c = coords(way)
        if len(c) < 2:
            continue
        closed = way["nodes"][0] == way["nodes"][-1] and len(c) >= 4
        if "highway" in tags and wid not in used_in_rel:
            h = tags["highway"]
            if h in ("footway", "path", "steps", "cycleway", "pedestrian", "service", "track", "living_street"):
                w_ = 2.5 if h in ("footway", "path", "steps") else 3.5
                kind = "path"
            elif h in ("residential", "unclassified", "tertiary"):
                w_ = 6.0
                kind = "street"
            elif h in ("secondary", "primary", "trunk"):
                w_ = 9.0
                kind = "main"
            elif h == "motorway":
                w_ = 14.0
                kind = "main"
            else:
                continue
            roads.append({"p": c, "w": w_, "kind": kind, "name": tags.get("name"), "oneway": tags.get("oneway") == "yes"})
        if "building" in tags and closed and wid not in used_in_rel:
            buildings.append({"p": c, "h": height(tags), "holes": [], "kind": tags.get("building", "yes"), "name": tags.get("name"), "num": tags.get("addr:housenumber"), "street": tags.get("addr:street"), "bag": tags.get("ref:bag")})
        if tags.get("natural") == "water" and closed and wid not in used_in_rel:
            water.append({"p": c, "holes": []})
        if "waterway" in tags and not closed:
            waterways.append({"p": c, "w": 6.0 if tags["waterway"] in ("river", "canal") else 2.5})
        if closed and (tags.get("landuse") in ("grass", "park", "forest", "cemetery", "allotments", "recreation_ground") or tags.get("leisure") in ("park", "pitch", "playground", "garden")):
            green.append({"p": c, "kind": tags.get("leisure") or tags.get("landuse")})
        if tags.get("railway") in ("rail", "tram"):
            rails.append({"p": c, "kind": tags["railway"]})
        nm = tags.get("name")
        named_kind = tags.get("shop") or tags.get("amenity") or tags.get("leisure") or tags.get("tourism") or tags.get("office") or tags.get("healthcare") or tags.get("sport") or tags.get("public_transport") or (tags.get("building") if tags.get("building") not in (None, "yes", "house", "garage", "garages", "shed", "apartments", "residential", "terrace", "detached", "semidetached_house", "construction", "roof") else None)
        if nm and named_kind and c:
            cx = sum(p[0] for p in c) / len(c)
            cy = sum(p[1] for p in c) / len(c)
            pois.append({"x": round(cx, 2), "y": round(cy, 2), "name": nm, "kind": named_kind})

    for nid, nd in nodes.items():
        tags = nd.get("tags", {})
        if not tags:
            continue
        if tags.get("natural") == "tree":
            trees.append(xy(nid))
        fk = FURNITURE.get((tags.get("amenity") and "amenity=" + tags["amenity"]) or "") or FURNITURE.get(
            (tags.get("barrier") and "barrier=" + tags["barrier"]) or "") or FURNITURE.get(
            (tags.get("highway") and "highway=" + tags["highway"]) or "")
        if fk:
            x, y = xy(nid)
            furniture.append({"x": x, "y": y, "k": fk})
        nm = tags.get("name")
        nk = tags.get("shop") or tags.get("amenity") or tags.get("leisure") or tags.get("tourism") or tags.get("office") or tags.get("healthcare")
        if nm and nk:
            x, y = xy(nid)
            pois.append({"x": x, "y": y, "name": nm, "kind": nk})

    # attach address nodes (addr:housenumber on points) to the building footprint they fall in
    def inside(px, py, poly):
        n = len(poly); j = n - 1; ok = False
        for i in range(n):
            xi, yi = poly[i]; xj, yj = poly[j]
            if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-9) + xi:
                ok = not ok
            j = i
        return ok
    addr_nodes = []
    for nid, nd in nodes.items():
        t = nd.get("tags", {})
        if "addr:housenumber" in t:
            x, y = xy(nid)
            addr_nodes.append((x, y, t["addr:housenumber"], t.get("addr:street")))
    # grid index of buildings by bbox
    cell = 40
    grid = {}
    for bi, b in enumerate(buildings):
        xs = [q[0] for q in b["p"]]; ys = [q[1] for q in b["p"]]
        b["_bb"] = (min(xs), min(ys), max(xs), max(ys))
        for gx in range(int(b["_bb"][0] // cell), int(b["_bb"][2] // cell) + 1):
            for gy in range(int(b["_bb"][1] // cell), int(b["_bb"][3] // cell) + 1):
                grid.setdefault((gx, gy), []).append(bi)
    matched = 0
    for x, y, num, street in addr_nodes:
        for bi in grid.get((int(x // cell), int(y // cell)), []):
            b = buildings[bi]; bb = b["_bb"]
            if bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3] and inside(x, y, b["p"]):
                b.setdefault("nums", []).append(num)
                if street and not b.get("street"):
                    b["street"] = street
                matched += 1
                break
    for b in buildings:
        b.pop("_bb", None)
        if b.get("num"):
            b.setdefault("nums", []).insert(0, b["num"])
        b.pop("num", None)
        if "nums" in b:
            b["nums"] = sorted(set(b["nums"]), key=lambda v: (len(v), v))
    print("address nodes", len(addr_nodes), "matched", matched)

    dedup = []
    for p_ in pois:
        if not any(q["name"] == p_["name"] and (q["x"]-p_["x"])**2 + (q["y"]-p_["y"])**2 < 25*25 for q in dedup):
            dedup.append(p_)
    pois = dedup

    block = {
        "center": {"lat": lat, "lon": lon},
        "half": half,
        "roads": roads,
        "buildings": buildings,
        "water": water,
        "waterways": waterways,
        "green": green,
        "rails": rails,
        "trees": trees,
        "pois": pois,
        "furniture": furniture,
    }
    with open(out, "w") as f:
        json.dump(block, f, separators=(",", ":"))
    print(f"furniture={len(furniture)} roads={len(roads)} buildings={len(buildings)} water={len(water)} waterways={len(waterways)} green={len(green)} rails={len(rails)} trees={len(trees)} pois={len(pois)}")


if __name__ == "__main__":
    import urllib.parse
    main()
