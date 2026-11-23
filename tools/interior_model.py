"""Blender (headless): the inside of a house, web/models/interior.glb and web/models/interior.json.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/interior_model.py

Every house has the same ground floor, 6 x 8 m and 2.7 m high: the front door with a coat rack and a
doormat, a kitchen along the right-hand wall, a dining table for six (the meeting table), and a living
room at the back with a sofa, a TV, a rug, a bookcase, a lamp and plants. The room itself (floor,
walls, skirting, ceiling, windows, the inside of the front door) is built here; the furniture is
low-poly CC0 models from Poly Pizza (Kenney's furniture kit and Quaternius), downloaded on first run
into data/interior/ and listed in web/models/CREDITS.txt.

Coordinates, in metres, y up after export: the origin is the middle of the front door's sill, the
outside is +z (like door.glb), so the room lies at -z: x from -3 to 3, z from 0 to -8.
interior.json has what the game needs to walk around in it, in the same coordinates:
  { size: [w, d, h], solids: [{ x, z, hx, hz, top }], seats: [{ x, z, yaw, h, kind }], lights: [[x, y, z]] }
"""
import json
import math
import os
import urllib.request

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "web", "models", "interior.glb")
OUT_JSON = os.path.join(HERE, "web", "models", "interior.json")
CACHE = os.path.join(HERE, "data", "interior")
W, D, H = 6.0, 8.0, 2.7          # the room
WALL = 0.15
DOOR_W, DOOR_H = 0.94, 2.12      # as door.glb
KENNEY = 2.0                     # Kenney's furniture kit is modelled at half size

# name -> (Poly Pizza file id, scale); credits in web/models/CREDITS.txt
MODELS = {
    "sofa": ("https://poly.pizza/m/jMu2iCmGxU", KENNEY), "coffee": ("https://poly.pizza/m/y4ZU5S7RuD", KENNEY),
    "tvcab": ("https://poly.pizza/m/AL6wwiUgP3", KENNEY), "tv": ("https://poly.pizza/m/mBGTVozH1u", 0.75),
    "rug": ("https://poly.pizza/m/k5oJLb49gw", KENNEY), "floorlamp": ("https://poly.pizza/m/8LiDIfXVLi", KENNEY),
    "bookcase": ("https://poly.pizza/m/MTH8ZwnA27", KENNEY), "plant": ("https://poly.pizza/m/IBLX2Jz90O", 2.0),
    "table": ("https://poly.pizza/m/41R2HTYj1O", KENNEY),
    "chair": ("https://poly.pizza/m/vHyrBYPBum", KENNEY), "ceiling": ("https://poly.pizza/m/sRNcgQFbLB", 0.6),
    "drawer": ("https://poly.pizza/m/rGZG7vK3fd", KENNEY),
    "sink": ("https://poly.pizza/m/nNGtcp9qK2", KENNEY), "stove": ("https://poly.pizza/m/kTJU2y4R15", KENNEY),
    "fridge": ("https://poly.pizza/m/McgsrFB5x6", KENNEY), "micro": ("https://poly.pizza/m/vUsvf2HGDv", KENNEY),
    "coatrack": ("https://poly.pizza/m/E49wno0xUd", KENNEY), "doormat": ("https://poly.pizza/m/nwwFXS6B9T", KENNEY),
}
UA = {"User-Agent": "Mozilla/5.0"}


def fetch(name, page):
    """the model's .glb, downloaded once: a Poly Pizza page names its file on static.poly.pizza"""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name + ".glb")
    if not os.path.exists(path):
        html = urllib.request.urlopen(urllib.request.Request(page, headers=UA), timeout=60).read().decode("utf8", "replace")
        uid = html.split("static.poly.pizza/")[1].split(".glb")[0]
        data = urllib.request.urlopen(urllib.request.Request(f"https://static.poly.pizza/{uid}.glb", headers=UA), timeout=60).read()
        open(path, "wb").write(data)
    return path


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
solids, seats, lights = [], [], []


def material(name, col, rough=0.8, emit=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1); b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = 1.0
    return m


FLOOR = material("floor", (0.42, 0.26, 0.14), 0.6)
WALLS = material("walls", (0.86, 0.82, 0.74), 0.9)
CEIL = material("ceiling", (0.95, 0.95, 0.93), 0.95)
TRIM = material("trim", (0.97, 0.97, 0.95), 0.5)
SKY = material("sky", (0.62, 0.8, 0.95), 0.2, emit=(0.62, 0.8, 0.95))   # the window: daylight, it glows
DOOR = material("doorpaint", (0.12, 0.25, 0.2), 0.5)
METAL = material("handle", (0.75, 0.72, 0.6), 0.3)


def box(name, x0, x1, y0, y1, z0, z1, mat):
    """an axis-aligned box in Blender coordinates (z up, the room along +y)"""
    bpy.ops.mesh.primitive_cube_add(size=1, location=((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    o = bpy.context.object; o.name = name; o.scale = (x1 - x0, y1 - y0, z1 - z0)
    bpy.ops.object.transform_apply(scale=True); o.data.materials.append(mat)
    return o


# ---------- the room: floor, ceiling, four walls with the front door and three windows ----------
box("floor", -W / 2, W / 2, 0, D, -0.1, 0, FLOOR)
box("ceiling", -W / 2, W / 2, 0, D, H, H + 0.1, CEIL)
box("wall_left", -W / 2 - WALL, -W / 2, 0, D, 0, H, WALLS)
box("wall_right", W / 2, W / 2 + WALL, 0, D, 0, H, WALLS)


def wall_y(name, y, holes):
    """a wall across the room at y (its inside face), with openings [(x0, x1, z0, z1, kind)]"""
    t0, t1 = (y - WALL, y) if y == 0 else (y, y + WALL)
    xs = sorted({-W / 2, W / 2, *[h[0] for h in holes], *[h[1] for h in holes]})
    for a, b in zip(xs, xs[1:]):
        hole = next((h for h in holes if h[0] <= a and b <= h[1]), None)
        if not hole:
            box(name, a, b, t0, t1, 0, H, WALLS); continue
        _, _, z0, z1, kind = hole
        if z0 > 0: box(name + "_below", a, b, t0, t1, 0, z0, WALLS)
        box(name + "_above", a, b, t0, t1, z1, H, WALLS)
        inner = t1 if y == 0 else t0   # the face in the room
        d = 0.06 if y == 0 else -0.06
        if kind == "window":
            box("glass", a, b, (t0 + t1) / 2 - 0.01, (t0 + t1) / 2 + 0.01, z0, z1, SKY)
            box("sill", a - 0.05, b + 0.05, min(inner, inner + d * 3), max(inner, inner + d * 3), z0 - 0.04, z0, TRIM)
            box("frame", a, b, (t0 + t1) / 2 - 0.03, (t0 + t1) / 2 + 0.03, (z0 + z1) / 2 - 0.03, (z0 + z1) / 2 + 0.03, TRIM)
            box("frame", (a + b) / 2 - 0.03, (a + b) / 2 + 0.03, (t0 + t1) / 2 - 0.03, (t0 + t1) / 2 + 0.03, z0, z1, TRIM)
        # a frame round the opening, on the room side
        for (fx0, fx1, fz0, fz1) in ((a - 0.07, a, z0, z1 + 0.07), (b, b + 0.07, z0, z1 + 0.07), (a - 0.07, b + 0.07, z1, z1 + 0.07)):
            box("casing", fx0, fx1, min(inner, inner + d / 2), max(inner, inner + d / 2), fz0, fz1, TRIM)


wall_y("wall_front", 0, [(-DOOR_W / 2, DOOR_W / 2, 0, DOOR_H, "door"), (-2.5, -1.3, 0.9, 2.1, "window"), (1.3, 2.5, 0.9, 2.1, "window")])
wall_y("wall_back", D, [(-1.3, 1.3, 0.6, 2.2, "window")])
# the front door from inside, closed: a leaf with panels and a lever
box("door_leaf", -DOOR_W / 2, DOOR_W / 2, -0.06, -0.01, 0, DOOR_H, DOOR)
for z0, z1 in ((0.15, 0.95), (1.1, 1.95)):
    box("door_panel", -DOOR_W / 2 + 0.12, DOOR_W / 2 - 0.12, -0.01, 0.01, z0, z1, DOOR)
box("door_handle", DOOR_W / 2 - 0.2, DOOR_W / 2 - 0.06, 0.0, 0.06, 1.0, 1.04, METAL)
# skirting along every wall, leaving the door free
for (x0, x1, y0, y1) in ((-W / 2, -DOOR_W / 2, 0, 0.02), (DOOR_W / 2, W / 2, 0, 0.02), (-W / 2, W / 2, D - 0.02, D),
                         (-W / 2, -W / 2 + 0.02, 0, D), (W / 2 - 0.02, W / 2, 0, D)):
    box("skirting", x0, x1, y0, y1, 0, 0.1, TRIM)

# ---------- furniture ----------
FACING = {"+y": 0, "-x": -math.pi / 2, "-y": math.pi, "+x": math.pi / 2}   # where its front looks


def place(name, x, y, facing="+y", z=0.0, solid=True, top=None, seat=None):
    """the model `name`, its footprint centred on x, y (Blender metres), its front towards `facing`"""
    page, scale = MODELS[name]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=fetch(name, page))
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new(name, None); scene.collection.objects.link(root)
    for o in new:
        if o.parent is None: o.parent = root
    root.scale = (scale,) * 3
    root.rotation_euler = (0, 0, FACING[facing] + math.pi)   # the kits' fronts look down -y in Blender
    bpy.context.view_layer.update()
    meshes = [o for o in new if o.type == "MESH"]
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    mn = [min(p[i] for p in pts) for i in range(3)]; mx = [max(p[i] for p in pts) for i in range(3)]
    root.location = (x - (mn[0] + mx[0]) / 2, y - (mn[1] + mx[1]) / 2, z - mn[2])
    hx, hy, h = (mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, mx[2] - mn[2]
    if solid:   # in three.js coordinates: x, z = -y
        solids.append({"name": name, "x": round(x, 3), "z": round(-y, 3), "hx": round(hx, 3), "hz": round(hy, 3), "top": round(top if top is not None else z + h, 3)})
    if seat:    # where a person sits, facing like the furniture; h: seat height
        for sx, sy in seat:
            seats.append({"kind": name, "x": round(x + sx, 3), "z": round(-(y + sy), 3), "yaw": round(FACING[facing], 4), "h": 0.45})
    return root, hx, hy, h


# the hall: doormat and a coat rack on the wall beside the door
place("doormat", 0, 0.5, "+y", solid=False)
place("coatrack", -W / 2 + 0.12, 1.2, "+x", z=1.45)

# the kitchen along the right-hand wall, fronts towards the room
ky = 0.75
for n in ("fridge", "sink", "stove", "drawer"):
    root, depth, width, h = place(n, 0, 0, "-x")   # measured at the origin, then moved into the row
    solids.pop()
    cx, cy = W / 2 - depth - 0.02, ky + width
    root.location.x += cx; root.location.y += cy
    solids.append({"name": n, "x": round(cx, 3), "z": round(-cy, 3), "hx": round(depth, 3), "hz": round(width, 3), "top": round(h, 3)})
    if n == "drawer":
        place("micro", cx, cy, "-x", z=h, solid=False)
    ky += 2 * width

# the dining table, for meetings: six chairs round it, a lamp above
TX, TY = -1.6, 3.0   # off the line from the front door into the room
place("table", TX, TY, "+x")
chairs = [(TX - 0.85, TY - 0.45, "+x"), (TX - 0.85, TY + 0.45, "+x"), (TX + 0.85, TY - 0.45, "-x"), (TX + 0.85, TY + 0.45, "-x"),
          (TX, TY - 1.2, "+y"), (TX, TY + 1.2, "-y")]
BACK = {"+x": "-x", "-x": "+x", "+y": "-y", "-y": "+y"}   # Kenney's chair is modelled facing the other way
for cx, cy, f in chairs:
    place("chair", cx, cy, BACK[f], seat=[(0, 0)])
    seats[-1]["yaw"] = round(FACING[f], 4)   # the sitter faces the table
place("ceiling", TX, TY, "+y", z=H - 0.6, solid=False)
lights.append([TX, H - 0.65, -TY])

# the living room at the back: TV on the left wall, the sofa facing it, a rug and a coffee table
LY = 6.3
place("rug", -0.3, LY, "+x", solid=False)
ch = place("tvcab", -W / 2 + 0.3, LY, "+x")[3]
place("tv", -W / 2 + 0.3, LY, "+x", z=ch, solid=False)
place("coffee", -0.4, LY, "+x")
place("sofa", 1.3, LY, "-x", seat=[(0, -0.55), (0, 0), (0, 0.55)])
place("floorlamp", 2.55, D - 0.45, "-x")
place("bookcase", -W / 2 + 0.3, D - 1.0, "+x")
place("plant", 2.5, 4.6, "-x")
place("plant", -2.55, 4.5, "+x")
lights.append([-0.3, H - 0.3, -LY])

# ---------- export: one object per material keeps the draw calls few ----------
for o in list(bpy.data.objects):
    if o.type == "MESH":
        o.select_set(True)
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
bpy.ops.object.select_all(action="DESELECT")
for o in [o for o in bpy.data.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o)
# the kits bring their own copies of the same material ("wood", "wood.001", ...): keep one of each
for o in bpy.data.objects:
    for slot in o.material_slots:
        if slot.material and "." in slot.material.name:
            base = bpy.data.materials.get(slot.material.name.split(".")[0])
            if base: slot.material = base
for o in bpy.data.objects: o.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.join()
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.separate(type="MATERIAL"); bpy.ops.object.mode_set(mode="OBJECT")
for o in bpy.data.objects:
    o.name = o.active_material.name if o.active_material else "mesh"
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True, export_lights=False, export_cameras=False)
json.dump({"size": [W, D, H], "solids": solids, "seats": seats, "lights": lights}, open(OUT_JSON, "w"), indent=1)
tris = sum(len(p.vertices) - 2 for o in bpy.data.objects for p in o.data.polygons)
print("WROTE", OUT, os.path.getsize(OUT), "bytes,", len(bpy.data.objects), "meshes,", tris, "triangles;", len(solids), "solids,", len(seats), "seats")
