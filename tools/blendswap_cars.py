"""Blender (headless): turn realistic BlendSwap car models into game-ready web/models/cars.glb.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blendswap_cars.py [-- name ...]
Sources (data/blendswap/<asset id>/, downloaded with the BlendSwap connector; licences in CREDITS below).
For each car:
  - keep the visible exterior only (no interior, brakes, studio floor, emitters, stray objects)
  - subdivision off, modifiers applied, all parts baked to world space and joined
  - every material mapped to one of a few clean PBR materials by its name:
      paint (white, tinted per parked car in the game), glass, tyre, metal, trim, headlight,
      taillight, plate (Dutch yellow)
  - uniform scale to the real length, length along X, centred, wheels on y = 0
  - two levels of detail: <name> (about HI_TRIS triangles) and <name>_lo (about LO_TRIS)
"""
import os
import re
import sys
import bpy
import bmesh
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "data", "blendswap")
OUT = os.path.join(HERE, "web", "models", "cars.glb")
HI_TRIS, LO_TRIS = 30000, 5000
HI_LIMIT = {"fiat500": 15000, "bike": 20000}
NO_LO = {"fiat500"}
# narrow and tall by nature: never "turned upright" by the cars' height-versus-width check
UPRIGHT = {"bike"}

# name: (file under data/blendswap, real length in metres, body object = the anchor for what belongs to the car)
CARS = {
    "golf": ("3976/x/GolfMK4-Cycles-Jay-Hardy-2011.blend", (4.15, 1.44), "Roof"),
    "camry": ("23001/x/Toyota Camry 2002.blend", (4.81, 1.42), "Camry "),
    "fiat500": ("13817/x/fiat500blandswap.blend", (3.55, 1.49), "Plane.001"),
    "jeep": ("25471/a.blend", (4.25, 1.63), "Jeep"),
    "van": ("19228/x/VAN.blend", (5.2, 2.0), "van_body"),
    # the file holds a clean SUV at the origin and a wrecked copy 6 m away; the anchor keeps the clean one
    "suv": ("29795/suv.blend", (4.55, 1.72), "UCR_GENSUV_ZYX0_2SBD.001"),
    # the damaged copy next to it in the same file: what the SUV turns into after a hard crash
    "suv_wreck": ("29795/suv.blend", (4.55, 1.72), "UCR_GENSUV_ZYX0_DMG_2SBD.001"),
    "bike": ("5449/x/vfr800.blend", (2.12, 1.2), "Plane.035"),
}
# the cars that go into the game; the others can still be built and switched back in here.
# Only the SUV (2026-11-21): one model in many paints loads in a tenth of the time and every car opens its doors.
IN_GAME = ["suv", "suv_wreck", "bike"]
# per car: extra object names to drop (snow cover, the bonus driver, interior) and material names to pin
EXTRA_DROP = {"suv": ("_snow", "_man", "_int_", "zyx0_006", "zyx0_1sbd")}
EXTRA_DROP["suv_wreck"] = EXTRA_DROP["suv"]
EXTRA_DROP["bike"] = ("cube.006", "plane.046", "beziercircle.001")   # hidden helpers at the file origin
# how far around the anchor a part may sit (share of its size) and whether a part wider than it is dropped.
# The bike's anchor is the lower fairing: the tank, the screen and the mirrors stand well above it.
REACH = {"bike": 0.4}
LOOSE = {"bike"}
# cars whose doors are separate parts in the source: each door is a list of objects, exported on its own as
# <name>_door<i> with its origin on the hinge (the front edge), next to <name>_body (the car without them).
# FRONT_END: which end of the finished car (along x) is the bonnet, to find each door's front edge.
DOORS = {
    "suv": [["UCR_GENSUV_ZYX0_2SBD.002"], ["UCR_GENSUV_ZYX0_2SBD.003"], ["UCR_GENSUV_ZYX0_2SBD.004"], ["UCR_GENSUV_ZYX0_2SBD.005"]],
}
# the van's front doors are separate too (van_door_FL/FR + doorglass + doorpanel), but its export clashes with
# object names in the source file; left out until that is sorted
FRONT_END = {"suv": -1, "van": 1}
# interior parts (seats, dashboard, steering wheel) exported as <name>_interior, only for the car you drive
INTERIOR = {"suv": ["UCR_GENSUV_ZYX0_006", "UCR_GENSUV_ZYX0_INT_ARCH_A", "UCR_GENSUV_ZYX0_INT_SEAT_B",
                    "UCR_GENSUV_ZYX0_INT_WALL", "UCR_GENSUV_ZYX0_1SBD"]}
# where the driver's (and the front passenger's) eyes are in the finished car, metres (x length, y width, z up,
# wheels on z = 0; the game sinks the car 15 cm). Dark trim panels between those eyes and the windscreen are
# cut from <name>_body, the version only the car you drive uses (see clear_view).
EYES = {"suv": [(-0.2, -0.38, 1.37), (-0.2, 0.38, 1.37)]}
MAT_PIN = {"suv": {"x_ucr_light": "headlight", "x_ucr_leather": "trim", "x_ucr_grey": "trim", "x_ucr_plastic_grey": "trim"}}
MAT_PIN["suv_wreck"] = MAT_PIN["suv"]
CREDITS = {
    "golf": "Volkswagen VW Golf MK4 by Jay-Artist, CC-BY, https://blendswap.com/blend/3976",
    "camry": "Toyota Camry 2001 by abdulsalamnaqeeb, CC-BY, https://blendswap.com/blend/23001",
    "fiat500": "Fiat500Abarth by Pierallard, CC-BY, https://blendswap.com/blend/13817",
    "jeep": "Jeep Cherokee with rig by koumis, CC0, https://blendswap.com/blend/25471",
    "van": "BEAMNG VAN by BlenderBach, CC-BY, https://blendswap.com/blend/19228",
    "suv": "Generic SUV ZYX0 by 1DInc, CC0, https://blendswap.com/blend/29795",
    "bike": "Honda VFR800 by danielfc10, CC-BY, https://blendswap.com/blend/5449",
}

DROP_OBJ = ("interior", "seat", "steer", "gauge", "dash", "brake", "caliper", "coilover", "floor", "studio",
            "camera", "lamp", "emit", "plane.000", "ground", "backdrop", "pedal", "engine", "exhaust", "spring",
            "shock", "axle", "susp", "driver", "light_cone")
DROP_MAT = ("emit", "studio", "floor", "interior", "seat", "gauge", "brake", "caliper")
# category: (base colour, metallic, roughness, alpha)
LOOK = {
    "paint": ((0.85, 0.85, 0.85), 0.2, 0.35, 1.0),
    "glass": ((0.03, 0.05, 0.07), 0.2, 0.05, 0.75),
    "tyre": ((0.025, 0.025, 0.025), 0.0, 0.85, 1.0),
    "metal": ((0.62, 0.63, 0.65), 0.9, 0.3, 1.0),
    "trim": ((0.03, 0.03, 0.035), 0.0, 0.6, 1.0),
    "headlight": ((0.85, 0.87, 0.9), 0.3, 0.1, 1.0),
    "taillight": ((0.55, 0.02, 0.02), 0.1, 0.15, 1.0),
    "plate": ((0.85, 0.65, 0.02), 0.0, 0.5, 1.0),
}


def category(mat):
    n = (mat.name if mat else "").lower()
    has = lambda *ks: any(k in n for k in ks)
    if has("plate", "plaque", "plates"):
        return "plate"
    if has("rear lamp", "taillight", "rear-light", "tail", "glass red", "red", "chmsl", "reverselight", "signal"):
        return "taillight"
    if has("headlight", "front-light", "hl glass", "light-cover", "headl", "lamp glass"):
        return "headlight"
    if has("glass", "window", "vitre", "glas"):
        return "glass"
    if has("tyre", "tire", "pneu", "opon", "opoma", "rubber"):
        return "tyre"
    if has("chrome", "alloy", "felga", "rim", "wheel", "steel", "metal", "sruba", "nut", "mirror", "jante", "logojante"):
        return "metal"
    if has("black", "noir", "plastic", "trim", "undercarriage", "caro", "rubber", "grill"):
        return "trim"
    if has("paint", "carpaint", "body", "van.001", "fiat", "jeep"):
        return "paint"
    return None  # decided by colour / area below


def materials():
    out = {}
    for k, (col, met, rough, alpha) in LOOK.items():
        m = bpy.data.materials.new(k)
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (*col, 1)
        b.inputs["Metallic"].default_value = met
        b.inputs["Roughness"].default_value = rough
        if alpha < 1:
            b.inputs["Alpha"].default_value = alpha
            m.blend_method = "BLEND" if hasattr(m, "blend_method") else None
        out[k] = m
    return out


def clear_view(mesh, eyes):
    """Delete the non-paint, non-glass faces you see through the windscreen from the driver's seat.
    Rays fan out over the front view (80 degrees wide, from below the dashboard line to well above);
    the first face each ray hits within 1.8 m goes if it is trim, then the rays go again until none hit."""
    from mathutils.bvhtree import BVHTree
    import math
    names = [m.name for m in mesh.materials]
    gone = 0
    for _ in range(40):
        bm = bmesh.new(); bm.from_mesh(mesh); bm.faces.ensure_lookup_table()
        solid = [f for f in bm.faces if not names[f.material_index].startswith("glass")]
        bvh = BVHTree.FromPolygons([v.co.copy() for v in bm.verts], [[v.index for v in f.verts] for f in solid])
        hit = set()
        for ex, ey, ez in eyes:
            for a in range(-40, 41, 2):
                for e in range(-20, 31):
                    ra, re = math.radians(a), math.radians(e)
                    d = Vector((-math.cos(re) * math.cos(ra), math.sin(ra), math.sin(re)))
                    _, _, i, dist = bvh.ray_cast(Vector((ex, ey, ez)), d, 1.8)
                    if i is not None and not names[solid[i].material_index].startswith("paint"):
                        hit.add(solid[i])
        if not hit:
            bm.free(); break
        bmesh.ops.delete(bm, geom=list(hit), context="FACES")
        bm.to_mesh(mesh); bm.free(); gone += len(hit)
    return gone


def convert(name, path, length, body):
    bpy.ops.wm.open_mainfile(filepath=os.path.join(SRC, path))
    mats = materials()   # after opening: loading a file replaces all data blocks
    scene = bpy.context.scene
    objs = [o for o in scene.objects if o.type in ("MESH", "CURVE") and not o.hide_render
            and (o.name in INTERIOR.get(name, ()) or not any(k in o.name.lower() for k in DROP_OBJ + EXTRA_DROP.get(name, ())))]
    for o in objs:                      # subdivision off: the cages are already smooth enough here
        for m in o.modifiers:
            if m.type == "SUBSURF":
                m.levels = 0
                m.render_levels = 0
    dg = bpy.context.evaluated_depsgraph_get()
    parts = []
    for o in objs:
        try:
            me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
        except RuntimeError:
            continue
        me.transform(o.matrix_world)
        if len(me.polygons):
            parts.append((o, me))
    # keep the main body cluster: anchor on the biggest paint-ish part, drop far or huge strays
    def bbox(me):
        xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
        return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))
    sized = [(me, *bbox(me), o.name) for o, me in parts]
    # the body: the part with the most faces among parts of car-like size (some files have
    # wheels or helpers scaled 10x, or tiny high-poly bolts)
    anchor = next(t for t in sized if t[3] == body)
    print("ANCHOR", name, anchor[0].name, len(anchor[0].polygons), [round(v, 2) for v in anchor[2] - anchor[1]])
    a0, a1 = anchor[1], anchor[2]
    span = (a1 - a0).length
    keep = []
    for me, b0, b1, _ in sized:
        c = (b0 + b1) / 2
        reach = REACH.get(name, 0.12)
        inside = all(a0[i] - reach * span <= c[i] <= a1[i] + reach * span for i in range(3))
        d = b1 - b0
        flat_sheet = min(d) < 0.005 * span and sorted(d)[1] > 0.3 * span     # backdrops, blueprints
        too_wide = name not in LOOSE and any(d[i] > (a1[i] - a0[i]) * 1.08 + 0.02 * span for i in range(3))
        if inside and not flat_sheet and not too_wide and d.length <= 1.05 * span:
            keep.append((me, _))
        elif os.environ.get("DEBUG_DROPS"):
            print("  DROPPED", name, _, "inside" if inside else "outside", "flat" if flat_sheet else "", "wide" if too_wide else "",
                  [round(v, 2) for v in d], [round(v, 2) for v in c])
            if (b1.y - b0.y) > (a1.y - a0.y) * 1.05 or (b1.x - b0.x) > (a1.x - a0.x) * 1.05:
                print("  WIDE", name, _, [round(v, 2) for v in (b1 - b0)])

    # one mesh, faces tagged with their category (paint_key: which unnamed material is the body paint)
    order = list(LOOK)

    def build(items, mesh_name, paint_key=None):
        bm = bmesh.new()
        cat_of_face = []
        area = {}
        for me, _ in items:
            tmp = bmesh.new(); tmp.from_mesh(me)
            cats = []
            for f in tmp.faces:
                mat = me.materials[f.material_index] if f.material_index < len(me.materials) else None
                if mat is not None and any(k in mat.name.lower() for k in DROP_MAT):
                    cats.append("_drop"); continue
                c = MAT_PIN.get(name, {}).get((mat.name if mat else "").lower()) or category(mat)
                if c is None:
                    c = "?" + (mat.name if mat else "")
                cats.append(c)
                area[c] = area.get(c, 0) + f.calc_area()
            tmp.to_mesh(me); tmp.free()
            bm.from_mesh(me)
            bm.faces.ensure_lookup_table()
            cat_of_face += cats
        # unknown materials: the largest is the body paint (if no paint was named), others go dark trim
        if paint_key is None:
            unknown = sorted((a, c) for c, a in area.items() if c.startswith("?"))
            paint_key = unknown[-1][1] if "paint" not in area and unknown else ""
        bm.faces.ensure_lookup_table()
        drop = []
        for f, c in zip(bm.faces, cat_of_face):
            if c == "_drop":
                drop.append(f); continue
            if c.startswith("?"):
                c = "paint" if c == paint_key else "trim"
            f.material_index = order.index(c)
        bmesh.ops.delete(bm, geom=drop, context="FACES")
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
        mesh = bpy.data.meshes.new(mesh_name)
        bm.to_mesh(mesh); bm.free()
        for k in order:
            mesh.materials.append(mats[k])
        return mesh, area, paint_key

    inside = set(INTERIOR.get(name, ()))
    interior_items = [it for it in keep if it[1] in inside]
    keep = [it for it in keep if it[1] not in inside]
    mesh, area, paint_key = build(keep, name)
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)

    M = Matrix.Identity(4)   # everything done to the whole car, to repeat on the door parts

    def tf(X):
        nonlocal M
        mesh.transform(X); M = X @ M

    # orient: length along X, then uniform scale to the real length, centred, wheels on z = 0
    def ext():
        xs = [v.co.x for v in mesh.vertices]; ys = [v.co.y for v in mesh.vertices]; zs = [v.co.z for v in mesh.vertices]
        return min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)
    x0, x1, y0, y1, z0, z1 = ext()
    dims = sorted([(x1 - x0, "x"), (y1 - y0, "y"), (z1 - z0, "z")], reverse=True)
    up = "z"
    if dims[0][1] == "z":               # some files are modelled lying on their side or with Y up
        tf(Matrix.Rotation(-1.5707963, 4, "X"))
        x0, x1, y0, y1, z0, z1 = ext()
    if (y1 - y0) > (x1 - x0):
        tf(Matrix.Rotation(1.5707963, 4, "Z"))
        x0, x1, y0, y1, z0, z1 = ext()
    if name not in UPRIGHT and (z1 - z0) > (y1 - y0) * 1.4:   # still wrong way up: a car is not much taller than wide
        tf(Matrix.Rotation(1.5707963, 4, "X"))
        x0, x1, y0, y1, z0, z1 = ext()
    length, height = length
    s = length / (x1 - x0)
    # uniform by length, then height corrected to the real car (some models are built tall)
    sz = height / (z1 - z0)
    tf(Matrix.Diagonal((s, s, sz, 1)) @ Matrix.Translation(Vector((-(x0 + x1) / 2, -(y0 + y1) / 2, -z0))))
    x0, x1, y0, y1, z0, z1 = ext()
    tris0 = len(mesh.polygons)

    def lod(src, target, suffix):
        # decimate through the depsgraph (no operators, so it works headless without a UI context)
        o = src.copy(); o.data = src.data.copy(); o.name = name + suffix
        scene.collection.objects.link(o)
        if target < 8000 and "_door" not in suffix and "_interior" not in suffix:
            # far version: small loose bits (bolts, badges, wipers) cost triangles and are invisible
            bm2 = bmesh.new(); bm2.from_mesh(o.data)
            seen, drop = set(), []
            for f in bm2.faces:
                if f.index in seen:
                    continue
                isl, stack = [], [f]
                seen.add(f.index)
                while stack:
                    g = stack.pop(); isl.append(g)
                    for e in g.edges:
                        for h in e.link_faces:
                            if h.index not in seen:
                                seen.add(h.index); stack.append(h)
                vs = [v.co for g in isl for v in g.verts]
                lo_, hi_ = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))), Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
                if (hi_ - lo_).length < 0.35:
                    drop += isl
            bmesh.ops.delete(bm2, geom=drop, context="FACES")
            # merge near-flat neighbouring triangles first; this works where collapse stalls
            bmesh.ops.dissolve_limit(bm2, angle_limit=0.09, verts=bm2.verts, edges=bm2.edges, delimit={"MATERIAL"})
            bmesh.ops.triangulate(bm2, faces=bm2.faces[:])
            bm2.to_mesh(o.data); bm2.free()
        for _ in range(4):                      # collapse decimation can stall above the target; repeat
            if len(o.data.polygons) <= target * 1.1:
                break
            d = o.modifiers.new("lod", "DECIMATE"); d.ratio = target / len(o.data.polygons); d.use_collapse_triangulate = True
            dgl = bpy.context.evaluated_depsgraph_get(); dgl.update()
            m = bpy.data.meshes.new_from_object(o.evaluated_get(dgl), depsgraph=dgl)
            o.modifiers.remove(d); o.data = m
        o.data.shade_smooth()
        if hasattr(o.data, "set_sharp_from_angle"):
            o.data.set_sharp_from_angle(angle=0.6)
        return o
    hi = lod(obj, HI_LIMIT.get(name, HI_TRIS), "")
    # some models fall apart when simplified hard; they use the near version at every distance
    lo = lod(hi, HI_LIMIT[name], "_lo") if name in NO_LO else lod(obj, LO_TRIS, "_lo")
    bpy.data.objects.remove(obj)
    print(f"CAR {name}: {tris0} -> {len(hi.data.polygons)} / {len(lo.data.polygons)} tris, "
          f"{x1 - x0:.2f} x {y1 - y0:.2f} x {z1 - z0:.2f} m, kept {len(keep)}/{len(parts)} parts, areas "
          + ", ".join(f"{c}:{a * s * s:.1f}" for c, a in sorted(area.items(), key=lambda t: -t[1])[:6]))
    # move to a fresh file for export
    extra = []
    if interior_items:
        im, _, _ = build(interior_items, name + "_interiorsrc", paint_key)
        im.transform(M)
        io = bpy.data.objects.new(name + "_interiorsrc", im); scene.collection.objects.link(io)
        extra.append(lod(io, 24000, "_interior"))   # seen from 30 cm away: keep its detail; bpy.data.objects.remove(io)
        print(f"  INTERIOR {name}: {len(extra[-1].data.polygons)} tris from {len(interior_items)} parts")
    if name in DOORS:
        doors = DOORS[name]
        in_door = {n for d in doors for n in d}
        body_mesh, _, _ = build([it for it in keep if it[1] not in in_door], name + "_body", paint_key)
        body_mesh.transform(M)
        if name in EYES:
            print(f"  VIEW {name}: {clear_view(body_mesh, EYES[name])} trim faces cleared from the windscreen")
        bo = bpy.data.objects.new(name + "_bodysrc", body_mesh); scene.collection.objects.link(bo)
        extra.append(lod(bo, 24000, "_body"))   # only the car you drive uses these: lighter; bpy.data.objects.remove(bo)
        for i, names in enumerate(doors):
            items = [it for it in keep if it[1] in names]
            if not items:
                print("  NO DOOR PARTS", name, names); continue
            dm, _, _ = build(items, f"{name}_door{i}src", paint_key)
            dm.transform(M)
            xs = [v.co.x for v in dm.vertices]; ys = [v.co.y for v in dm.vertices]
            ymid = (min(ys) + max(ys)) / 2
            hinge = Vector((min(xs) if FRONT_END[name] < 0 else max(xs), min(ys) if ymid < 0 else max(ys), 0))
            dm.transform(Matrix.Translation(-hinge))
            do = bpy.data.objects.new(f"{name}_door{i}src", dm); do.location = hinge; scene.collection.objects.link(do)
            extra.append(lod(do, 2000, f"_door{i}")); bpy.data.objects.remove(do)
            print(f"  DOOR {name}{i}: hinge {tuple(round(v, 2) for v in hinge)}, {len(extra[-1].data.polygons)} tris")
    return hi, lo, extra


def main():
    only = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else list(CARS)
    built = []
    for name in only:
        path, length, body = CARS[name]
        bpy.ops.wm.read_factory_settings(use_empty=True)
        try:
            hi, lo, extra = convert(name, path, length, body)
        except Exception as e:
            print("FAILED", name, repr(e)); continue
        tmp = os.path.join(HERE, "data", "blendswap", f"_{name}.glb")
        for o in bpy.context.scene.objects:
            o.select_set(o in (hi, lo, *extra))
        bpy.ops.export_scene.gltf(filepath=tmp, export_format="GLB", use_selection=True, export_yup=True,
                                  export_apply=True, export_materials="EXPORT")
        built.append(tmp)
    # merge the per-car files into one: every car built so far, so one car can be rebuilt on its own
    bpy.ops.wm.read_factory_settings(use_empty=True)
    built = [os.path.join(HERE, "data", "blendswap", f"_{n}.glb") for n in IN_GAME
             if os.path.exists(os.path.join(HERE, "data", "blendswap", f"_{n}.glb"))]
    for f in built:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=f)
        new = sorted((o for o in bpy.data.objects if o not in before and o.type == "MESH"), key=lambda o: -len(o.data.polygons))
        n = os.path.basename(f)[1:-4]
        for o in new:   # Blender adds .001 when a source object already had the name
            o.name = re.sub(r"\.\d{3}$", "", o.name)
        if any(o.name == n for o in new):
            continue   # the names came through (doors and bodies rely on them)
        new = [o for o in new if "_door" not in o.name and not o.name.endswith(("_body", "_interior"))]
        new[0].name = n
        if len(new) > 1:
            new[1].name = n + "_lo"
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
    with open(os.path.join(HERE, "web", "models", "CREDITS.txt"), "w") as fh:
        fh.write("Car models from BlendSwap (licence as declared by the uploader):\n")
        for n in IN_GAME:
            if n in CREDITS: fh.write(f"- {CREDITS[n]}\n")
        fh.write("Person: Xbot from the three.js examples, dressed with tools/dress_person.py.\n")
    print("WROTE", OUT, os.path.getsize(OUT))


main()
