#!/usr/bin/env python3
"""Bake whole Dutch municipalities into 500 m squares for streaming (step 1 of 2: collect data).

Usage: tilebake.py SLUG --gemeente Barendrecht [--gemeente Rotterdam] [--workers 6] [--only I_J ...]
Then:  node tools/buildtiles.mjs SLUG      (step 2: pre-build GPU-ready geometry)

Everything is in the Dutch national grid (RD New, EPSG:28992, metres), so squares line up exactly.
Square (i, j) covers RD x in [i*500, i*500+500) and y in [j*500, j*500+500); raw files store
coordinates relative to that square's south-west corner.

Sources (free, no keys):
  PDOK bestuurlijke gebieden   municipality outlines -> which squares to bake
  OpenStreetMap (Geofabrik)    names, house numbers, shops, street names, street furniture
  3D BAG                       every building: footprint, LoD 1.2 block and LoD 2.2 roof shape
  BGT                          water, every road/pavement/garden surface, trees, lamps, hedges, walls
  PDOK aerial photo            ground and roof imagery, 2048 px (near) and 512 px (far) per square
Output: data/<slug>/raw/I_J.json, web/regions/<slug>/a/I_J.jpg + I_J_s.jpg, data/<slug>/search.json
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
T = 500.0
RD = "http://www.opengis.net/def/crs/EPSG/0/28992"
GEM = "https://api.pdok.nl/kadaster/brk-bestuurlijke-gebieden/ogc/v1/collections/gemeentegebied/items"
BAG3D = "https://api.3dbag.nl/collections/pand/items"
BGT = "https://api.pdok.nl/kadaster/bgt/ogc/v1/collections/{}/items"
BAG_ADRES = "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/adres/items"
WMS = ("https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?service=WMS&version=1.3.0&request=GetMap"
       "&layers=Actueel_orthoHR&styles=&crs=EPSG:28992&format=image/jpeg")
PBF = os.path.join(HERE, "data", "extracts", "zuid-holland.osm.pbf")
BGT_LAYERS = ["waterdeel", "wegdeel", "ondersteunendwegdeel", "begroeidterreindeel", "onbegroeidterreindeel",
              "vegetatieobject_punt", "vegetatieobject_vlak", "paal", "straatmeubilair", "scheiding_vlak"]
FURNITURE = {
    "barrier=bollard": "bollard", "amenity=waste_basket": "bin", "amenity=bench": "bench",
    "amenity=bicycle_parking": "bikerack", "highway=bus_stop": "busstop", "amenity=charging_station": "charger",
    "amenity=post_box": "postbox", "amenity=recycling": "recycling", "amenity=vending_machine": "vending",
}
POI_KEYS = ("shop", "amenity", "leisure", "tourism", "office", "healthcare", "craft", "historic")
SKIP_POI = {"parking", "bench", "waste_basket", "bicycle_parking", "parking_entrance", "post_box", "recycling",
            "charging_station", "vending_machine", "parking_space", "motorcycle_parking", "waste_disposal"}


# ---------- WGS84 <-> RD (Schreutelkamp & Strang van Hees, about 1 m) ----------
def wgs_to_rd(lat, lon):
    dp, dl = 0.36 * (lat - 52.15517440), 0.36 * (lon - 5.38720621)
    x = (190094.945 * dl - 11832.228 * dp * dl - 114.221 * dp * dp * dl - 32.391 * dl ** 3 - 0.705 * dp
         - 2.340 * dp ** 3 * dl - 0.608 * dp * dl ** 3 - 0.008 * dl * dl + 0.148 * dp * dp * dl ** 3)
    y = (309056.544 * dp + 3638.893 * dl * dl + 73.077 * dp * dp - 157.984 * dp * dl * dl + 59.788 * dp ** 3
         + 0.433 * dl - 6.439 * dp * dp * dl * dl - 0.032 * dp * dl + 0.092 * dl ** 4 - 0.054 * dp * dl ** 4)
    return 155000 + x, 463000 + y


def rd_to_wgs(x, y):
    dx, dy = (x - 155000) * 1e-5, (y - 463000) * 1e-5
    n = (3235.65389 * dy - 32.58297 * dx ** 2 - 0.2475 * dy ** 2 - 0.84978 * dx ** 2 * dy - 0.0655 * dy ** 3
         - 0.01709 * dx ** 2 * dy ** 2 - 0.00738 * dx + 0.0053 * dx ** 4 - 0.00039 * dx ** 2 * dy ** 3
         + 0.00033 * dx ** 4 * dy - 0.00012 * dx * dy)
    e = (5260.52916 * dx + 105.94684 * dx * dy + 2.45656 * dx * dy ** 2 - 0.81885 * dx ** 3 + 0.05594 * dx * dy ** 3
         - 0.05607 * dx ** 3 * dy + 0.01199 * dy - 0.00256 * dx ** 3 * dy ** 2 + 0.00128 * dx * dy ** 4
         + 0.00022 * dy ** 2 - 0.00022 * dx ** 2 + 0.00026 * dx ** 5)
    return 52.15517440 + n / 3600, 5.38720621 + e / 3600


# ---------- small geometry helpers ----------
def pip(x, y, poly):
    ok = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            ok = not ok
        j = i
    return ok


def bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def clip(ring, x0, y0, x1, y1):
    """Sutherland-Hodgman against an axis-aligned rectangle."""
    def cut(pts, inside, inter):
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            ia, ib = inside(a), inside(b)
            if ib:
                if not ia:
                    out.append(inter(a, b))
                out.append(b)
            elif ia:
                out.append(inter(a, b))
        return out

    def ix(xc):
        return lambda a, b: (xc, a[1] + (b[1] - a[1]) * (xc - a[0]) / ((b[0] - a[0]) or 1e-12))

    def iy(yc):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (yc - a[1]) / ((b[1] - a[1]) or 1e-12), yc)

    pts = [tuple(p) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    for inside, inter in ((lambda p: p[0] >= x0, ix(x0)), (lambda p: p[0] <= x1, ix(x1)),
                          (lambda p: p[1] >= y0, iy(y0)), (lambda p: p[1] <= y1, iy(y1))):
        pts = cut(pts, inside, inter)
        if len(pts) < 3:
            return []
    return pts


def loc(pts, ox, oy):
    return [[round(p[0] - ox, 2), round(p[1] - oy, 2)] for p in pts]


def get(url, timeout=120, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "toycity-proto/0.2"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network hiccups and 429/5xx: back off and retry
            if k == tries - 1:
                raise RuntimeError(f"{e} for {url}")
            time.sleep(2 + 3 * k)


def paged(url):
    feats = []
    while url:
        page = json.loads(get(url))
        tf = (page.get("metadata") or {}).get("transform")
        for f in page.get("features", []):
            if tf and "transform" not in f:
                f["transform"] = tf   # 3D BAG: each page has its own vertex transform
        feats += page.get("features", [])
        url = next((l["href"] for l in page.get("links", []) if l["rel"] == "next"), None)
        if not page.get("features"):
            break
    return feats


# ---------- municipality outlines -> squares ----------
def municipality(name):
    path = os.path.join(HERE, "data", "extracts", f"gem-{name}.json")
    if not os.path.exists(path):
        open(path, "wb").write(get(f"{GEM}?f=json&naam={urllib.parse.quote(name)}"))
    polys = []
    for f in json.load(open(path))["features"]:
        g = f["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            polys.append([wgs_to_rd(lat, lon) for lon, lat in poly[0]])
    return polys


def squares_for(polys):
    out = set()
    for poly in polys:
        x0, y0, x1, y1 = bbox(poly)
        for i in range(int(x0 // T), int(x1 // T) + 1):
            for j in range(int(y0 // T), int(y1 // T) + 1):
                cx, cy = i * T, j * T
                corners = [(cx, cy), (cx + T, cy), (cx, cy + T), (cx + T, cy + T), (cx + T / 2, cy + T / 2)]
                if any(pip(x, y, poly) for x, y in corners) or any(cx <= x < cx + T and cy <= y < cy + T for x, y in poly):
                    out.add((i, j))
    return sorted(out)


# ---------- OpenStreetMap: names, addresses, furniture, streets ----------
def osm_layers(slug, squares):
    xs = [i * T for i, _ in squares] + [(i + 1) * T for i, _ in squares]
    ys = [j * T for _, j in squares] + [(j + 1) * T for _, j in squares]
    la0, lo0 = rd_to_wgs(min(xs) - 200, min(ys) - 200)
    la1, lo1 = rd_to_wgs(max(xs) + 200, max(ys) + 200)
    d = os.path.join(HERE, "data", slug)
    os.makedirs(d, exist_ok=True)
    cut, filt, seq = (os.path.join(d, n) for n in ("region.osm.pbf", "filtered.osm.pbf", "osm.geojsonseq"))
    if not os.path.exists(seq):
        print("cutting OpenStreetMap extract")
        subprocess.run(["osmium", "extract", "-O", "-s", "smart", "-b", f"{lo0},{la0},{lo1},{la1}", PBF, "-o", cut], check=True)
        subprocess.run(["osmium", "tags-filter", "-O", cut, "nwr/addr:housenumber", "nwr/shop", "nwr/amenity", "nwr/leisure",
                        "nwr/tourism", "nwr/office", "nwr/healthcare", "nwr/craft", "nwr/historic", "n/barrier=bollard",
                        "n/highway=bus_stop", "w/highway", "nwr/building", "-o", filt], check=True)
        subprocess.run(["osmium", "export", "-O", "-f", "geojsonseq", "-a", "type,id", filt, "-o", seq], check=True)

    per = {}
    bagnames = {}

    def bucket(x, y):
        return per.setdefault((int(x // T), int(y // T)), {"addr": [], "pois": [], "furn": [], "streets": []})

    def centre(g):
        t = g["type"]
        if t == "Point":
            return g["coordinates"]
        ring = g["coordinates"][0] if t == "Polygon" else g["coordinates"][0][0] if t == "MultiPolygon" else g["coordinates"]
        return [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]

    # bus stops count only when a bus route actually serves them: OSM keeps stale stops for
    # discontinued lines (e.g. Schaatsbaan, Barendrecht), and served stops are members of a route=bus relation
    served = set()
    routes = subprocess.run(["osmium", "tags-filter", "-R", "-O", cut, "r/route=bus,trolleybus,tram", "-f", "opl", "-o", "-"],
                            check=True, capture_output=True, text=True).stdout
    for row in routes.splitlines():
        if row.startswith("r") and " M" in row:
            for m in row.split(" M", 1)[1].split(" ")[0].split(","):
                if m.startswith("n"):
                    served.add(int(m[1:].split("@")[0]))
    print(f"  {len(served)} nodes served by bus/tram routes")

    for line in open(seq, encoding="utf8"):
        line = line.strip().lstrip("\x1e")
        if not line:
            continue
        f = json.loads(line)
        t, g = f["properties"], f["geometry"]
        if g is None:
            continue
        if "highway" in t and g["type"] == "LineString":
            if t.get("name"):
                pts = [wgs_to_rd(la, lo) for lo, la in g["coordinates"]]
                for key in {(int(x // T), int(y // T)) for x, y in pts}:
                    per.setdefault(key, {"addr": [], "pois": [], "furn": [], "streets": []})["streets"].append(
                        {"n": t["name"], "p": loc(pts, key[0] * T, key[1] * T)})
            continue
        lo, la = centre(g)
        x, y = wgs_to_rd(la, lo)
        b = bucket(x, y)
        ox, oy = int(x // T) * T, int(y // T) * T
        if t.get("ref:bag") and ("building" in t):
            bagnames[t["ref:bag"].lstrip("0")] = {"k": t.get("building"), "n": t.get("name")}
        if "addr:housenumber" in t:
            b["addr"].append({"x": round(x - ox, 2), "y": round(y - oy, 2), "n": t["addr:housenumber"] + t.get("addr:unit", ""),
                              "s": t.get("addr:street")})
        fk = next((FURNITURE[f"{k}={t[k]}"] for k in ("amenity", "barrier", "highway") if f"{k}={t.get(k)}" in FURNITURE), None)
        if fk == "busstop" and not (t.get("@type") == "node" and t.get("@id") in served):
            fk = None
        if fk and g["type"] == "Point":
            b["furn"].append({"x": round(x - ox, 2), "y": round(y - oy, 2), "k": fk})
        kind = next((t[k] for k in POI_KEYS if k in t), None)
        if t.get("name") and kind and kind not in SKIP_POI:
            b["pois"].append({"x": round(x - ox, 2), "y": round(y - oy, 2), "n": t["name"], "k": kind})
        elif t.get("name") and t.get("building") in ("school", "church", "civic", "public", "hospital", "university", "train_station", "chapel", "cathedral", "mosque", "sports_hall"):
            b["pois"].append({"x": round(x - ox, 2), "y": round(y - oy, 2), "n": t["name"], "k": t["building"]})
    return per, bagnames


# ---------- 3D BAG ----------
def bag_square(i, j):
    x0, y0 = i * T, j * T
    feats = paged(f"{BAG3D}?bbox={x0},{y0},{x0 + T},{y0 + T}&limit=50")
    out, blockers = [], []
    for f in feats:
        verts = f["vertices"]
        sc, tr = f["transform"]["scale"], f["transform"]["translate"]
        attrs, foot, bag_id = {}, None, None
        lods = {}
        for oid, obj in f["CityObjects"].items():
            if obj["type"] == "Building":
                attrs = obj.get("attributes", {})
                bag_id = oid.rsplit(".", 1)[-1].lstrip("0")
                for g in obj.get("geometry", []):
                    if g["lod"] == "0":
                        foot = g["boundaries"][0][0]
            elif obj["type"] == "BuildingPart":
                for g in obj.get("geometry", []):
                    lods.setdefault(g["lod"], []).append(g)
        if not foot:
            continue
        ground = attrs.get("b3_h_maaiveld") or 0.0
        R = lambda vi: (verts[vi][0] * sc[0] + tr[0], verts[vi][1] * sc[1] + tr[1], verts[vi][2] * sc[2] + tr[2])
        fp = [R(v)[:2] for v in foot]
        cx = sum(p[0] for p in fp) / len(fp)
        cy = sum(p[1] for p in fp) / len(fp)
        if not (x0 <= cx < x0 + T and y0 <= cy < y0 + T):
            blockers.append(loc(fp, x0, y0))   # owned by a neighbouring square, still blocks walking here
            continue

        def mesh(lod):
            geos = lods.get(lod)
            if not geos:
                return None
            local, faces, sems = {}, [], []
            for geo in geos:
                sem = geo.get("semantics", {})
                stypes = [s["type"] for s in sem.get("surfaces", [])]
                for si, shell in enumerate(geo["boundaries"]):
                    svals = sem.get("values", [[]])[si] if sem else []
                    for fi, face in enumerate(shell):
                        ring = face[0]
                        for vi in ring:
                            local.setdefault(vi, len(local))
                        faces.append([local[vi] for vi in ring])
                        sv = svals[fi] if fi < len(svals) else None
                        st = stypes[sv] if sv is not None and sv < len(stypes) else "WallSurface"
                        sems.append(0 if st == "GroundSurface" else 1 if st == "RoofSurface" else 2)
            v = [0.0] * (3 * len(local))
            for vi, li in local.items():
                X, Y, Z = R(vi)
                v[3 * li], v[3 * li + 1], v[3 * li + 2] = round(X - x0, 2), round(Y - y0, 2), round(Z - ground, 2)
            return {"v": v, "f": faces, "s": sems}

        out.append({"bag": bag_id, "p": loc(fp, x0, y0), "h": round((attrs.get("b3_h_dak_max") or ground) - ground, 2),
                    "roof": attrs.get("b3_dak_type"), "year": attrs.get("oorspronkelijkbouwjaar"),
                    "m22": mesh("2.2"), "m12": mesh("1.2")})
    return out, blockers


# ---------- BGT ----------
def surface_kind(layer, p):
    look = (p.get("plus_fysiek_voorkomen") or "") + " " + (p.get("fysiek_voorkomen") or "")
    if layer == "wegdeel":
        fn = p.get("functie") or ""
        if "parkeer" in fn:
            return "parking"
        if "fiets" in fn:
            return "cycle"
        if "rijbaan" in fn or "inrit" in fn or "OV-baan" in fn or "baan" in fn:
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


def bgt_square(i, j):
    x0, y0 = i * T, j * T
    q = f"bbox={x0},{y0},{x0 + T},{y0 + T}&bbox-crs={RD}&crs={RD}&limit=1000&f=json"
    res = {"surfaces": [], "water": [], "hedges": [], "walls": [], "trees": [], "lamps": [], "play": []}
    for layer in BGT_LAYERS:
        for f in paged(f"{BGT.format(layer)}?{q}"):
            p, g = f["properties"], f.get("geometry")
            if not g or p.get("eind_registratie") or (p.get("relatieve_hoogteligging") or 0) < 0:
                continue
            if g["type"] == "Point":
                x, y = g["coordinates"][:2]
                if not (x0 <= x < x0 + T and y0 <= y < y0 + T):
                    continue
                pt = [round(x - x0, 2), round(y - y0, 2)]
                kind = p.get("plus_type") or ""
                if layer == "vegetatieobject_punt":
                    res["trees"].append(pt)
                elif layer == "paal" and "licht" in kind:
                    res["lamps"].append(pt)
                elif layer == "straatmeubilair" and "speel" in kind:
                    res["play"].append(pt)
                continue
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []
            for poly in polys:
                outer = clip(poly[0], x0, y0, x0 + T, y0 + T)
                if len(outer) < 3:
                    continue
                holes = [h for h in (clip(h, x0, y0, x0 + T, y0 + T) for h in poly[1:]) if len(h) >= 3]
                rec = {"p": loc(outer, x0, y0), "holes": [loc(h, x0, y0) for h in holes]}
                if layer == "waterdeel":
                    res["water"].append(rec)
                elif layer == "vegetatieobject_vlak":
                    res["hedges"].append(rec)
                elif layer == "scheiding_vlak":
                    res["walls"].append(rec)
                else:
                    rec["k"] = surface_kind(layer, p)
                    res["surfaces"].append(rec)
    return res


def addr_square(i, j):
    """Every official BAG address in the square (OSM only has a fraction of them)."""
    x0, y0 = i * T, j * T
    out = []
    for f in paged(f"{BAG_ADRES}?bbox={x0},{y0},{x0 + T},{y0 + T}&bbox-crs={RD}&crs={RD}&limit=1000&f=json"):
        p, g = f["properties"], f.get("geometry")
        if not g or not p.get("huisnummer"):
            continue
        x, y = g["coordinates"][:2]
        if not (x0 <= x < x0 + T and y0 <= y < y0 + T):
            continue
        n = str(p["huisnummer"]) + (p.get("huisletter") or "") + (("-" + p["toevoeging"]) if p.get("toevoeging") else "")
        out.append({"x": round(x - x0, 2), "y": round(y - y0, 2), "n": n, "s": p.get("openbare_ruimte_naam")})
    return out


def aerial_square(slug, i, j):
    d = os.path.join(HERE, "web", "regions", slug, "a")
    os.makedirs(d, exist_ok=True)
    x0, y0 = i * T, j * T
    for suffix, px in (("", 2048), ("_s", 512)):
        f = os.path.join(d, f"{i}_{j}{suffix}.jpg")
        if not os.path.exists(f):
            data = get(f"{WMS}&bbox={x0},{y0},{x0 + T},{y0 + T}&width={px}&height={px}")
            if not data.startswith(b"\xff\xd8"):
                raise RuntimeError("aerial: " + data[:200].decode("utf8", "replace"))
            open(f, "wb").write(data)


def bake_square(slug, i, j, osm, bagnames):
    out = os.path.join(HERE, "data", slug, "raw", f"{i}_{j}.json")
    if os.path.exists(out):
        t = json.load(open(out))
        if t.get("addr_src") == "bag":
            return "cached"
        t["addr"], t["addr_src"] = addr_square(i, j), "bag"   # older bake: only refresh the addresses
        json.dump(t, open(out + ".tmp", "w"), separators=(",", ":")); os.replace(out + ".tmp", out)
        return f"addresses refreshed: {len(t['addr'])}"
    buildings, blockers = bag_square(i, j)
    for b in buildings:
        o = bagnames.get(b["bag"])
        if o:
            b["kind"], b["name"] = o["k"], o["n"]
    tile = {"i": i, "j": j, "buildings": buildings, "blockers": blockers, **bgt_square(i, j),
            **osm.get((i, j), {"addr": [], "pois": [], "furn": [], "streets": []})}
    tile["addr"], tile["addr_src"] = addr_square(i, j), "bag"
    aerial_square(slug, i, j)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(tile, open(out + ".tmp", "w"), separators=(",", ":"))
    os.replace(out + ".tmp", out)
    return f"{len(buildings)} buildings, {len(tile['surfaces'])} surfaces, {len(tile['trees'])} trees"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--gemeente", action="append", required=True)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--title")
    ap.add_argument("--start", help="address to start at")
    ap.add_argument("--refresh-osm", action="store_true", help="re-read OSM names, addresses-less layers and furniture into already baked squares")
    a = ap.parse_args()

    polys = [p for g in a.gemeente for p in municipality(g)]
    squares = squares_for(polys)
    if a.only:
        squares = [s for s in squares if f"{s[0]}_{s[1]}" in a.only]
    print(f"{len(squares)} squares for {', '.join(a.gemeente)}")
    osm, bagnames = osm_layers(a.slug, squares)

    if a.refresh_osm:
        for i, j in squares:
            f = os.path.join(HERE, "data", a.slug, "raw", f"{i}_{j}.json")
            if os.path.exists(f):
                tile = json.load(open(f))
                o = osm.get((i, j), {"pois": [], "furn": [], "streets": []})
                tile["pois"], tile["furn"], tile["streets"] = o["pois"], o["furn"], o["streets"]
                json.dump(tile, open(f + ".tmp", "w"), separators=(",", ":")); os.replace(f + ".tmp", f)
        print("refreshed OSM layers in", len(squares), "squares")

    done, failed = 0, []
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(bake_square, a.slug, i, j, osm, bagnames): (i, j) for i, j in squares}
        for fu in as_completed(futs):
            i, j = futs[fu]
            done += 1
            try:
                msg = fu.result()
            except Exception as e:
                failed.append((i, j))
                msg = f"FAILED {e}"
            print(f"[{done}/{len(squares)}] {i}_{j}: {msg}", flush=True)

    # search index: every address, named place and street once, in RD metres
    search = {"addr": [], "pois": [], "streets": {}}
    for i, j in squares:
        f = os.path.join(HERE, "data", a.slug, "raw", f"{i}_{j}.json")
        if os.path.exists(f):
            for ad in json.load(open(f))["addr"]:
                if ad["s"]:
                    search["addr"].append([ad["s"], ad["n"], round(ad["x"] + i * T, 1), round(ad["y"] + j * T, 1)])
    for (i, j), b in osm.items():
        ox, oy = i * T, j * T
        for p in b["pois"]:
            search["pois"].append([p["n"], round(p["x"] + ox, 1), round(p["y"] + oy, 1)])
        for s in b["streets"]:
            if s["n"] not in search["streets"]:
                pt = s["p"][len(s["p"]) // 2]
                search["streets"][s["n"]] = [round(pt[0] + ox, 1), round(pt[1] + oy, 1)]
    web = os.path.join(HERE, "web", "regions", a.slug)
    os.makedirs(web, exist_ok=True)
    json.dump(search, open(os.path.join(web, "search.json"), "w"), separators=(",", ":"))

    start = None
    if a.start:
        r = json.loads(get("https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=1&fl=centroide_rd,weergavenaam&q="
                           + urllib.parse.quote(a.start)))["response"]["docs"][0]
        sx, sy = map(float, r["centroide_rd"].replace("POINT(", "").rstrip(")").split())
        start = {"x": sx, "y": sy, "label": a.start}
    baked = sorted(s for s in squares if os.path.exists(os.path.join(HERE, "data", a.slug, "raw", f"{s[0]}_{s[1]}.json")))
    json.dump({"tile": T, "title": a.title or " + ".join(a.gemeente), "squares": baked, "start": start},
              open(os.path.join(HERE, "data", a.slug, "squares.json"), "w"))
    print(f"done: {len(baked)} squares baked, {len(failed)} failed {failed[:10]}")


if __name__ == "__main__":
    main()
