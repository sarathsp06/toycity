#!/usr/bin/env python3
"""Bake whole Dutch municipalities into 500 m squares for streaming (step 1 of 2: collect data).

Usage: tilebake.py SLUG --gemeente Barendrecht [--gemeente Rotterdam] [--workers 6] [--only I_J ...] [--bbox X0 Y0 X1 Y1]
                   [--osm data/extracts/noord-holland.osm.pbf]
                   [--title "Rotterdam + Barendrecht"] [--start "Coolsingel 40, Rotterdam"]
Then:  node tools/buildtiles.mjs SLUG      (step 2: pre-build GPU-ready geometry)

Everything is in the Dutch national grid (RD New, EPSG:28992, metres), so squares line up exactly.
Square (i, j) covers RD x in [i*500, i*500+500) and y in [j*500, j*500+500); raw files store
coordinates relative to that square's south-west corner, rounded to the centimetre.

Sources (free, no keys):
  PDOK bestuurlijke gebieden   municipality outlines -> which squares to bake
  OpenStreetMap (Geofabrik)    names of shops and places, building kinds, street names, street furniture
  3D BAG                       every building: footprint, LoD 1.2 block and LoD 2.2 roof shape
  BGT                          water, every road/pavement/garden surface, trees, lamps, hedges, walls
  BAG addresses                every official house number (OSM has only some of them)
  PDOK aerial photo            ground and roof imagery, 2048 px (near) and 512 px (far) per square
Output: data/<slug>/raw/I_J.json, data/<slug>/squares.json, web/regions/<slug>/a/I_J.jpg + I_J_s.jpg,
        web/regions/<slug>/search.json
"""
import argparse
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
T = 500.0                # square size in metres
OSM_MARGIN = 200         # cut OpenStreetMap this far beyond the squares, so streets crossing the edge are whole
RD = "http://www.opengis.net/def/crs/EPSG/0/28992"
GEM = "https://api.pdok.nl/kadaster/brk-bestuurlijke-gebieden/ogc/v1/collections/gemeentegebied/items"
BAG3D = "https://api.3dbag.nl/collections/pand/items"
BGT = "https://api.pdok.nl/kadaster/bgt/ogc/v1/collections/{}/items"
BAG_ADRES = "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/adres/items"
LOCATIESERVER = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"
WMS = ("https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?service=WMS&version=1.3.0&request=GetMap"
       "&layers=Actueel_orthoHR&styles=&crs=EPSG:28992&format=image/jpeg")
AERIAL_PX = (("", 2048), ("_s", 512))   # file suffix and size: 2048 px = 25 cm per pixel up close, 512 px far away
PBF = os.path.join(HERE, "data", "extracts", "zuid-holland.osm.pbf")   # default; --osm picks another province
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
NAMED_BUILDINGS = {"school", "church", "civic", "public", "hospital", "university", "train_station", "chapel",
                   "cathedral", "mosque", "sports_hall"}   # named buildings worth a label even without a shop tag
GROUND, ROOF, WALL = 0, 1, 2   # surface codes stored per 3D BAG face


# ---------- WGS84 (GPS degrees) <-> RD (metres) ----------
# The approximation published by Schreutelkamp & Strang van Hees ("Benaderingsformules voor de
# transformatie tussen RD- en WGS84-kaartcoördinaten", 2001): two polynomials around the RD origin,
# the old observatory tower of Amersfoort. Accurate to about a metre across the Netherlands, which is
# plenty for clipping data to squares (the 3D BAG, BGT and BAG data are already in RD).
AMERSFOORT_RD = (155000.0, 463000.0)            # RD x, y of the origin, metres
AMERSFOORT_WGS = (52.15517440, 5.38720621)      # the same point as latitude, longitude, degrees

# RD -> WGS84: inputs are dx, dy = RD offset from the origin in units of 100 km; the sums are in
# arcseconds. Each entry is (power of dx, power of dy, coefficient).
LAT_TERMS = [(0, 1, 3235.65389), (2, 0, -32.58297), (0, 2, -0.2475), (2, 1, -0.84978), (0, 3, -0.0655),
             (2, 2, -0.01709), (1, 0, -0.00738), (4, 0, 0.0053), (2, 3, -0.00039), (4, 1, 0.00033), (1, 1, -0.00012)]
LON_TERMS = [(1, 0, 5260.52916), (1, 1, 105.94684), (1, 2, 2.45656), (3, 0, -0.81885), (1, 3, 0.05594),
             (3, 1, -0.05607), (0, 1, 0.01199), (3, 2, -0.00256), (1, 4, 0.00128), (0, 2, 0.00022),
             (2, 0, -0.00022), (5, 0, 0.00026)]
# WGS84 -> RD: inputs are dlat, dlon = offset from the origin in units of 10,000 arcseconds (degrees x 0.36);
# the sums are in metres. Each entry is (power of dlat, power of dlon, coefficient).
X_TERMS = [(0, 1, 190094.945), (1, 1, -11832.228), (2, 1, -114.221), (0, 3, -32.391), (1, 0, -0.705),
           (3, 1, -2.340), (1, 3, -0.608), (0, 2, -0.008), (2, 3, 0.148)]
Y_TERMS = [(1, 0, 309056.544), (0, 2, 3638.893), (2, 0, 73.077), (1, 2, -157.984), (3, 0, 59.788),
           (0, 1, 0.433), (2, 2, -6.439), (1, 1, -0.032), (0, 4, 0.092), (1, 4, -0.054)]
ARCSEC_PER_DEG = 3600


def poly2(terms, a, b):
    return sum(c * a ** p * b ** q for p, q, c in terms)


def wgs_to_rd(lat, lon):
    dlat = (lat - AMERSFOORT_WGS[0]) * ARCSEC_PER_DEG / 1e4
    dlon = (lon - AMERSFOORT_WGS[1]) * ARCSEC_PER_DEG / 1e4
    return AMERSFOORT_RD[0] + poly2(X_TERMS, dlat, dlon), AMERSFOORT_RD[1] + poly2(Y_TERMS, dlat, dlon)


def rd_to_wgs(x, y):
    dx, dy = (x - AMERSFOORT_RD[0]) / 1e5, (y - AMERSFOORT_RD[1]) / 1e5
    return (AMERSFOORT_WGS[0] + poly2(LAT_TERMS, dx, dy) / ARCSEC_PER_DEG,
            AMERSFOORT_WGS[1] + poly2(LON_TERMS, dx, dy) / ARCSEC_PER_DEG)


# ---------- small geometry helpers ----------
def inside(x, y, poly):
    """Is (x, y) inside the polygon? Cast a ray to the right and count the edges it crosses: odd = inside."""
    hit = False
    for (xi, yi), (xj, yj) in zip(poly, poly[-1:] + poly[:-1]):
        if (yi > y) != (yj > y) and x < xi + (xj - xi) * (y - yi) / (yj - yi):   # the edge spans y; is the crossing to the right?
            hit = not hit
    return hit


def bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def clip(ring, x0, y0, x1, y1):
    """Cut a polygon to the rectangle [x0, x1] x [y0, y1] (Sutherland-Hodgman: one rectangle side at a time).
    Returns the clipped ring, or [] when less than a triangle is left."""
    def at_x(xc):   # where the edge a-b crosses the vertical line x = xc
        return lambda a, b: (xc, a[1] + (b[1] - a[1]) * (xc - a[0]) / (b[0] - a[0]))

    def at_y(yc):   # where the edge a-b crosses the horizontal line y = yc
        return lambda a, b: (a[0] + (b[0] - a[0]) * (yc - a[1]) / (b[1] - a[1]), yc)

    pts = [tuple(p) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]   # GeoJSON repeats the first point at the end
    for keep, cross in ((lambda p: p[0] >= x0, at_x(x0)), (lambda p: p[0] <= x1, at_x(x1)),
                        (lambda p: p[1] >= y0, at_y(y0)), (lambda p: p[1] <= y1, at_y(y1))):
        out = []
        for a, b in zip(pts[-1:] + pts[:-1], pts):   # every edge a -> b
            if keep(b):
                if not keep(a):
                    out.append(cross(a, b))   # coming back in
                out.append(b)
            elif keep(a):
                out.append(cross(a, b))       # going out
        pts = out
        if len(pts) < 3:
            return []
    return pts


def cm(v):
    return round(v, 2)


def local(pts, ox, oy):
    """RD points relative to a square's south-west corner, to the centimetre."""
    return [[cm(p[0] - ox), cm(p[1] - oy)] for p in pts]


def square_of(x, y):
    return int(x // T), int(y // T)


def in_square(x, y, x0, y0):
    return x0 <= x < x0 + T and y0 <= y < y0 + T


def get(url, timeout=120, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "toycity-bake/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network hiccups and 429/5xx: back off (2, 5, 8 s) and retry
            if k == tries - 1:
                raise RuntimeError(f"{e} for {url}")
            time.sleep(2 + 3 * k)


def paged(url):
    """All features of an OGC API query, following its 'next' links."""
    feats = []
    while url:
        page = json.loads(get(url))
        tf = (page.get("metadata") or {}).get("transform")
        for f in page.get("features", []):
            if tf and "transform" not in f:
                f["transform"] = tf   # 3D BAG: vertices are integers, scaled by each page's own transform
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
            polys.append([wgs_to_rd(lat, lon) for lon, lat in poly[0]])   # outer ring only
    return polys


def squares_for(polys):
    """Every square that overlaps a municipality: one of its corners or its centre lies inside the outline,
    or a point of the outline lies inside the square (catches thin slivers along the border)."""
    out = set()
    for poly in polys:
        x0, y0, x1, y1 = bbox(poly)
        for i in range(int(x0 // T), int(x1 // T) + 1):
            for j in range(int(y0 // T), int(y1 // T) + 1):
                sx, sy = i * T, j * T
                probes = [(sx, sy), (sx + T, sy), (sx, sy + T), (sx + T, sy + T), (sx + T / 2, sy + T / 2)]
                if any(inside(x, y, poly) for x, y in probes) or any(in_square(x, y, sx, sy) for x, y in poly):
                    out.add((i, j))
    return sorted(out)


# ---------- OpenStreetMap: names, furniture, streets ----------
def empty_osm():
    return {"pois": [], "furn": [], "streets": []}


def osm_layers(slug, squares):
    xs = [i * T for i, _ in squares] + [(i + 1) * T for i, _ in squares]
    ys = [j * T for _, j in squares] + [(j + 1) * T for _, j in squares]
    la0, lo0 = rd_to_wgs(min(xs) - OSM_MARGIN, min(ys) - OSM_MARGIN)
    la1, lo1 = rd_to_wgs(max(xs) + OSM_MARGIN, max(ys) + OSM_MARGIN)
    d = os.path.join(HERE, "data", slug)
    os.makedirs(d, exist_ok=True)
    cut, filt, seq = (os.path.join(d, n) for n in ("region.osm.pbf", "filtered.osm.pbf", "osm.geojsonseq"))
    if not os.path.exists(seq):
        print("cutting OpenStreetMap extract")
        subprocess.run(["osmium", "extract", "-O", "-s", "smart", "-b", f"{lo0},{la0},{lo1},{la1}", PBF, "-o", cut], check=True)
        subprocess.run(["osmium", "tags-filter", "-O", cut, "nwr/shop", "nwr/amenity", "nwr/leisure",
                        "nwr/tourism", "nwr/office", "nwr/healthcare", "nwr/craft", "nwr/historic", "n/barrier=bollard",
                        "n/highway=bus_stop", "w/highway", "nwr/building", "-o", filt], check=True)
        subprocess.run(["osmium", "export", "-O", "-f", "geojsonseq", "-a", "type,id", filt, "-o", seq], check=True)

    per = {}          # (i, j) -> that square's pois, furniture and streets
    bagnames = {}     # BAG building id -> what OSM says the building is ("k", e.g. church) and its name

    def bucket(key):
        return per.setdefault(key, empty_osm())

    def centre(g):    # average of the outer ring's points: good enough to place a label or a bench
        t = g["type"]
        if t == "Point":
            return g["coordinates"]
        ring = g["coordinates"][0] if t == "Polygon" else g["coordinates"][0][0] if t == "MultiPolygon" else g["coordinates"]
        return [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]

    # bus stops count only when a bus route actually serves them: OSM keeps stale stops for
    # discontinued lines (e.g. Schaatsbaan, Barendrecht), and served stops are members of a route relation.
    # In osmium's OPL text format a relation line reads "r<id> ... M<type><id>@<role>,<type><id>@<role>,...".
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
        line = line.strip().lstrip("\x1e")   # GeoJSON text sequences start each record with a record separator
        if not line:
            continue
        f = json.loads(line)
        t, g = f["properties"], f["geometry"]
        if g is None:
            continue
        if "highway" in t and g["type"] == "LineString":
            if t.get("name"):
                pts = [wgs_to_rd(la, lo) for lo, la in g["coordinates"]]
                for key in {square_of(x, y) for x, y in pts}:   # the whole street goes to every square it touches
                    bucket(key)["streets"].append({"n": t["name"], "p": local(pts, key[0] * T, key[1] * T)})
            continue
        lo, la = centre(g)
        x, y = wgs_to_rd(la, lo)
        key = square_of(x, y)
        b, here = bucket(key), [cm(x - key[0] * T), cm(y - key[1] * T)]
        if t.get("ref:bag") and "building" in t:
            bagnames[t["ref:bag"].lstrip("0")] = {"k": t.get("building"), "n": t.get("name")}
        fk = next((FURNITURE[f"{k}={t[k]}"] for k in ("amenity", "barrier", "highway") if f"{k}={t.get(k)}" in FURNITURE), None)
        if fk == "busstop" and not (t.get("@type") == "node" and t.get("@id") in served):
            fk = None
        if fk and g["type"] == "Point":
            b["furn"].append({"x": here[0], "y": here[1], "k": fk})
        kind = next((t[k] for k in POI_KEYS if k in t), None)
        if t.get("name") and kind and kind not in SKIP_POI:
            b["pois"].append({"x": here[0], "y": here[1], "n": t["name"], "k": kind})
        elif t.get("name") and t.get("building") in NAMED_BUILDINGS:
            b["pois"].append({"x": here[0], "y": here[1], "n": t["name"], "k": t["building"]})
    return per, bagnames


# ---------- 3D BAG: buildings ----------
def bag_square(i, j, bagnames):
    """The buildings whose footprint centre lies in this square, plus the footprints of neighbours' buildings
    that reach into it ("blockers": you can't walk through them here either)."""
    x0, y0 = i * T, j * T
    feats = paged(f"{BAG3D}?bbox={x0},{y0},{x0 + T},{y0 + T}&limit=50")
    out, blockers = [], []
    for f in feats:
        verts = f["vertices"]
        scale, shift = f["transform"]["scale"], f["transform"]["translate"]
        attrs, foot, bag_id, lods = {}, None, None, {}
        for oid, obj in f["CityObjects"].items():
            if obj["type"] == "Building":
                attrs = obj.get("attributes", {})
                bag_id = oid.rsplit(".", 1)[-1].lstrip("0")
                for g in obj.get("geometry", []):
                    if g["lod"] == "0":
                        foot = g["boundaries"][0][0]   # LoD 0: the footprint's outer ring
            elif obj["type"] == "BuildingPart":
                for g in obj.get("geometry", []):
                    lods.setdefault(g["lod"], []).append(g)
        if not foot:
            continue
        ground = attrs.get("b3_h_maaiveld") or 0.0   # height of the ground at the building (NAP metres)

        def vertex(vi):
            return tuple(verts[vi][k] * scale[k] + shift[k] for k in range(3))

        fp = [vertex(v)[:2] for v in foot]
        cx = sum(p[0] for p in fp) / len(fp)
        cy = sum(p[1] for p in fp) / len(fp)
        if not in_square(cx, cy, x0, y0):
            blockers.append(local(fp, x0, y0))
            continue

        def mesh(lod):
            """One LoD as a small indexed mesh: v = x, y, height above the ground; f = faces; s = surface codes."""
            geos = lods.get(lod)
            if not geos:
                return None
            index, faces, surf = {}, [], []
            for geo in geos:
                sem = geo.get("semantics", {})
                types = [s["type"] for s in sem.get("surfaces", [])]
                for si, shell in enumerate(geo["boundaries"]):
                    values = sem.get("values", [[]])[si] if sem else []
                    for fi, face in enumerate(shell):
                        ring = face[0]   # outer ring only; 3D BAG faces have no holes we need
                        for vi in ring:
                            index.setdefault(vi, len(index))
                        faces.append([index[vi] for vi in ring])
                        sv = values[fi] if fi < len(values) else None
                        kind = types[sv] if sv is not None and sv < len(types) else "WallSurface"
                        surf.append(GROUND if kind == "GroundSurface" else ROOF if kind == "RoofSurface" else WALL)
            v = [0.0] * (3 * len(index))
            for vi, li in index.items():
                X, Y, Z = vertex(vi)
                v[3 * li:3 * li + 3] = cm(X - x0), cm(Y - y0), cm(Z - ground)
            return {"v": v, "f": faces, "s": surf}

        rec = {"p": local(fp, x0, y0), "h": cm((attrs.get("b3_h_dak_max") or ground) - ground),   # top of the roof
               "m22": mesh("2.2"), "m12": mesh("1.2")}
        if bag_id in bagnames:
            rec["kind"] = bagnames[bag_id]["k"]
        out.append(rec)
    return out, blockers


# ---------- BGT: the ground, water, trees, lamps, hedges, walls ----------
def surface_kind(layer, p):
    """Turn a BGT surface into one of our ground materials. BGT values are Dutch: functie (what it is for)
    and fysiek voorkomen (what it looks like)."""
    look = (p.get("plus_fysiek_voorkomen") or "") + " " + (p.get("fysiek_voorkomen") or "")
    if layer == "wegdeel":   # road parts
        fn = p.get("functie") or ""
        if "parkeer" in fn:
            return "parking"
        if "fiets" in fn:                                       # fietspad: cycle path
            return "cycle"
        if "baan" in fn or "inrit" in fn:                       # rijbaan, OV-baan: carriageway; inrit: driveway
            return "road" if "asfalt" in look or "gesloten" in look else "brickroad"   # gesloten verharding: sealed
        return "pavement"
    if layer == "ondersteunendwegdeel":                         # the bits beside a road
        return "kerbisland" if "eiland" in (p.get("functie") or "") else "verge"
    if layer == "begroeidterreindeel":                          # planted ground
        if any(w in look for w in ("struik", "heester", "bodembedek", "rozen", "haag")):   # shrubs, ground cover, roses, hedge
            return "plants"
        return "grass"
    if "zand" in look:
        return "sand"
    if "erf" in look:                                           # erf: private yard
        return "yard"
    return "paved"


def bgt_square(i, j):
    x0, y0 = i * T, j * T
    q = f"bbox={x0},{y0},{x0 + T},{y0 + T}&bbox-crs={RD}&crs={RD}&limit=1000&f=json"
    res = {"surfaces": [], "water": [], "hedges": [], "walls": [], "trees": [], "lamps": [], "play": []}
    for layer in BGT_LAYERS:
        for f in paged(f"{BGT.format(layer)}?{q}"):
            p, g = f["properties"], f.get("geometry")
            # skip ended records and anything below ground level (tunnels, underpasses)
            if not g or p.get("eind_registratie") or (p.get("relatieve_hoogteligging") or 0) < 0:
                continue
            if g["type"] == "Point":
                x, y = g["coordinates"][:2]
                if not in_square(x, y, x0, y0):
                    continue
                pt = [cm(x - x0), cm(y - y0)]
                kind = p.get("plus_type") or ""
                if layer == "vegetatieobject_punt":
                    res["trees"].append(pt)
                elif layer == "paal" and "licht" in kind:            # lichtmast: lamp post
                    res["lamps"].append(pt)
                elif layer == "straatmeubilair" and "speel" in kind:  # speeltoestel: playground equipment
                    res["play"].append(pt)
                continue
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []
            for poly in polys:
                outer = clip(poly[0], x0, y0, x0 + T, y0 + T)
                if not outer:
                    continue
                holes = [h for h in (clip(h, x0, y0, x0 + T, y0 + T) for h in poly[1:]) if h]
                rec = {"p": local(outer, x0, y0), "holes": [local(h, x0, y0) for h in holes]}
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


# ---------- BAG: addresses ----------
def addr_square(i, j):
    """Every official address in the square: s = street, n = number with letter and addition (e.g. 12A-2)."""
    x0, y0 = i * T, j * T
    out = []
    for f in paged(f"{BAG_ADRES}?bbox={x0},{y0},{x0 + T},{y0 + T}&bbox-crs={RD}&crs={RD}&limit=1000&f=json"):
        p, g = f["properties"], f.get("geometry")
        if not g or not p.get("huisnummer"):
            continue
        x, y = g["coordinates"][:2]
        if not in_square(x, y, x0, y0):
            continue
        n = str(p["huisnummer"]) + (p.get("huisletter") or "") + (("-" + p["toevoeging"]) if p.get("toevoeging") else "")
        out.append({"x": cm(x - x0), "y": cm(y - y0), "n": n, "s": p.get("openbare_ruimte_naam")})
    return out


# ---------- aerial photographs ----------
def aerial_square(slug, i, j):
    d = os.path.join(HERE, "web", "regions", slug, "a")
    os.makedirs(d, exist_ok=True)
    x0, y0 = i * T, j * T
    for suffix, px in AERIAL_PX:
        f = os.path.join(d, f"{i}_{j}{suffix}.jpg")
        if not os.path.exists(f):
            data = get(f"{WMS}&bbox={x0},{y0},{x0 + T},{y0 + T}&width={px}&height={px}")
            if not data.startswith(b"\xff\xd8"):   # not a JPEG: the server sent an error message instead
                raise RuntimeError("aerial: " + data[:200].decode("utf8", "replace"))
            open(f, "wb").write(data)


def bake_square(slug, i, j, osm, bagnames):
    out = os.path.join(HERE, "data", slug, "raw", f"{i}_{j}.json")
    if os.path.exists(out):
        return "cached"   # delete the file to bake the square again
    buildings, blockers = bag_square(i, j, bagnames)
    tile = {"i": i, "j": j, "buildings": buildings, "blockers": blockers, **bgt_square(i, j),
            **osm.get((i, j), empty_osm()), "addr": addr_square(i, j)}
    aerial_square(slug, i, j)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(tile, open(out + ".tmp", "w"), separators=(",", ":"))
    os.replace(out + ".tmp", out)   # never leave a half-written square behind
    return f"{len(buildings)} buildings, {len(tile['surfaces'])} surfaces, {len(tile['trees'])} trees"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--gemeente", action="append", required=True, help="municipality name; repeat for more")
    ap.add_argument("--workers", type=int, default=6, help="squares fetched at the same time")
    ap.add_argument("--only", nargs="*", help="bake only these squares, as I_J")
    ap.add_argument("--title")
    ap.add_argument("--start", help="address to start at")
    ap.add_argument("--osm", help="Geofabrik province extract (.osm.pbf), default zuid-holland")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"), help="keep only squares inside this RD box")
    a = ap.parse_args()
    global PBF
    PBF = a.osm or PBF

    polys = [p for g in a.gemeente for p in municipality(g)]
    squares = squares_for(polys)
    if a.only:
        squares = [s for s in squares if f"{s[0]}_{s[1]}" in a.only]
    if a.bbox:
        x0, y0, x1, y1 = a.bbox
        squares = [(i, j) for i, j in squares if x0 <= i * T < x1 and y0 <= j * T < y1]
    print(f"{len(squares)} squares for {', '.join(a.gemeente)}")
    osm, bagnames = osm_layers(a.slug, squares)

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

    # search index: every address, named place and street once, in RD metres (to the decimetre)
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
                pt = s["p"][len(s["p"]) // 2]   # a street is found at its middle point
                search["streets"][s["n"]] = [round(pt[0] + ox, 1), round(pt[1] + oy, 1)]
    web = os.path.join(HERE, "web", "regions", a.slug)
    os.makedirs(web, exist_ok=True)
    json.dump(search, open(os.path.join(web, "search.json"), "w"), separators=(",", ":"))

    start = None
    if a.start:
        r = json.loads(get(f"{LOCATIESERVER}?rows=1&fl=centroide_rd,weergavenaam&q=" + urllib.parse.quote(a.start)))
        point = r["response"]["docs"][0]["centroide_rd"]   # "POINT(x y)"
        sx, sy = map(float, point.replace("POINT(", "").rstrip(")").split())
        start = {"x": sx, "y": sy, "label": a.start}
    baked = sorted(s for s in squares if os.path.exists(os.path.join(HERE, "data", a.slug, "raw", f"{s[0]}_{s[1]}.json")))
    json.dump({"tile": T, "title": a.title or " + ".join(a.gemeente), "squares": baked, "start": start},
              open(os.path.join(HERE, "data", a.slug, "squares.json"), "w"))
    print(f"done: {len(baked)} squares baked, {len(failed)} failed {failed[:10]}")


if __name__ == "__main__":
    main()
