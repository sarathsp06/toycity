"""Blender (headless): the inside of a house, web/models/interior.glb and web/models/interior.json.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/interior_model.py

Every house has the same ground floor, 6 x 8 m and 2.7 m high: a hall, a kitchen along the right-hand
wall, a dining table for six (the meeting table), and a living room at the back with a sofa, an
armchair, a TV, a rug, shelves and plants. The room itself (laminate floor, plastered walls, skirting,
ceiling, windows, the inside of the front door), the kitchen and the TV are built here; the furniture
and decorations are photo-scanned CC0 models from Poly Haven, and the floor, wall and wood textures
are Poly Haven's too, downloaded on first run into data/interior/ (credits in web/models/CREDITS.txt).
Textures are made 512 px in the export so the house stays a few megabytes.

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
TEX = 512                        # texture size in the export

# name -> Poly Haven model id (https://polyhaven.com/a/<id>, CC0)
MODELS = {
    "sofa": "Sofa_01", "armchair": "ArmChair_01", "coffee": "modern_coffee_table_01", "table": "dining_table",
    "chair": "painted_wooden_chair_01", "shelves": "wooden_display_shelves_01", "plant": "potted_plant_04",
    "lamp": "modern_ceiling_lamp_01", "picture": "hanging_picture_frame_01", "clock": "wall_clock",
    "side": "side_table_01", "pillows": "throw_pillows_01",
}
TEXTURES = ["laminate_floor_02", "beige_wall_001", "floor_tiles_06", "wood_cabinet_worn_long"]
UA = {"User-Agent": "toycity"}


def download(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()


def fetch(aid):
    """a Poly Haven model at 1k, downloaded once: its .gltf with the files it includes"""
    d = os.path.join(CACHE, "ph", aid)
    if not os.path.isdir(d):
        g = json.loads(download(f"https://api.polyhaven.com/files/{aid}"))["gltf"]["1k"]["gltf"]
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, os.path.basename(g["url"])), "wb").write(download(g["url"]))
        for p, inc in g.get("include", {}).items():
            os.makedirs(os.path.join(d, os.path.dirname(p)), exist_ok=True)
            open(os.path.join(d, p), "wb").write(download(inc["url"]))
    return next(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".gltf"))


def texture(aid, kind):
    """a Poly Haven texture at 1k (kind Diffuse or nor_gl), downloaded once"""
    p = os.path.join(CACHE, "tex", f"{aid}_{kind}.jpg")
    if not os.path.exists(p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").write(download(json.loads(download(f"https://api.polyhaven.com/files/{aid}"))[kind]["1k"]["jpg"]["url"]))
    return p


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
solids, seats, lights = [], [], []


def material(name, col, rough=0.8, emit=None, tex=None, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1); b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = 1.0
    if tex:   # a Poly Haven texture: colour and normal map
        c = nt.nodes.new("ShaderNodeTexImage"); c.image = bpy.data.images.load(texture(tex, "Diffuse"))
        nt.links.new(c.outputs["Color"], b.inputs["Base Color"])
        n = nt.nodes.new("ShaderNodeTexImage"); n.image = bpy.data.images.load(texture(tex, "nor_gl")); n.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap"); nt.links.new(n.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    return m


FLOOR = material("floor", (1, 1, 1), 0.5, tex="laminate_floor_02")
TILES = material("tiles", (1, 1, 1), 0.4, tex="floor_tiles_06")
WALLS = material("walls", (1, 1, 1), 0.9, tex="beige_wall_001")
CEIL = material("ceiling", (0.95, 0.95, 0.93), 0.95)
TRIM = material("trim", (0.97, 0.97, 0.95), 0.5)
SKY = material("sky", (0.62, 0.8, 0.95), 0.2, emit=(0.62, 0.8, 0.95))   # the window: daylight, it glows
DOOR = material("doorpaint", (0.12, 0.25, 0.2), 0.5)
METAL = material("handle", (0.75, 0.72, 0.6), 0.3, metal=1.0)
CABINET = material("cabinet", (0.93, 0.92, 0.88), 0.35)
WORKTOP = material("worktop", (1, 1, 1), 0.45, tex="wood_cabinet_worn_long")
STEEL = material("steel", (0.75, 0.76, 0.78), 0.25, metal=1.0)
HOB = material("hob", (0.02, 0.02, 0.02), 0.08)
SCREEN = material("screen", (0.01, 0.01, 0.015), 0.05)
SHADOWLINE = material("gap", (0.25, 0.24, 0.22), 0.8)
RUG = material("rug", (0.32, 0.36, 0.42), 1.0)
TVWOOD = material("tvwood", (1, 1, 1), 0.5, tex="wood_cabinet_worn_long")


def box(name, x0, x1, y0, y1, z0, z1, mat):
    """an axis-aligned box in Blender coordinates (z up, the room along +y)"""
    bpy.ops.mesh.primitive_cube_add(size=1, location=((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    o = bpy.context.object; o.name = name; o.scale = (x1 - x0, y1 - y0, z1 - z0)
    bpy.ops.object.transform_apply(scale=True); o.data.materials.append(mat)
    # texture coordinates in metres (a tile of `UV_M[mat]` metres), so floors and walls are to scale
    t = UV_M.get(mat.name, 1.0); uv = o.data.uv_layers.active.data
    for poly in o.data.polygons:
        nx, ny, nz = (abs(v) for v in poly.normal)
        for li in poly.loop_indices:
            co = o.data.vertices[o.data.loops[li].vertex_index].co + o.location
            uv[li].uv = ((co.x, co.y) if nz > max(nx, ny) else (co.y, co.z) if nx > ny else (co.x, co.z))
            uv[li].uv = (uv[li].uv[0] / t, uv[li].uv[1] / t)
    return o


UV_M = {"floor": 2.0, "tiles": 1.2, "walls": 2.0, "worktop": 1.5, "tvwood": 1.0}


# ---------- the room: floor, ceiling, four walls with the front door and three windows ----------
box("floor", -W / 2, W / 2, 1.6, D, -0.1, 0, FLOOR)
box("hall_floor", -W / 2, W / 2, 0, 1.6, -0.1, 0, TILES)   # tiles in the hall
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


def place(name, x, y, facing="+y", z=0.0, solid=True, top=None, seat=None, scale=1.0):
    """the model `name`, its footprint centred on x, y (Blender metres), its front towards `facing`"""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=fetch(MODELS[name]))
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new(name, None); scene.collection.objects.link(root)
    for o in new:
        if o.parent is None: o.parent = root
    root.scale = (scale,) * 3
    root.rotation_euler = (0, 0, FACING[facing] + math.pi)   # Poly Haven's fronts look down -y in Blender
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
            seats.append({"kind": "sofa" if name == "armchair" else name, "x": round(x + sx, 3), "z": round(-(y + sy), 3), "yaw": round(FACING[facing], 4), "h": 0.45})
    return root, hx, hy, h


# the hall: a doormat, a picture and a clock
box("doormat", -0.45, 0.45, 0.15, 0.75, 0, 0.012, RUG)
place("picture", -W / 2 + 0.03, 1.0, "-x", z=1.2, solid=False)   # the frame is modelled facing the other way
place("clock", W / 2 - 0.04, 0.6, "-x", z=1.8, solid=False)

# the kitchen along the right-hand wall: base cabinets with a worktop, a sink and a hob, wall
# cupboards above, and a tall fridge at the end
K0, K1, KD = 1.0, 4.2, 0.62          # from, to (y), depth
kx = W / 2 - KD
box("cabinets", kx, W / 2, K0, K1 - 0.66, 0.1, 0.88, CABINET)
box("plinth", kx + 0.06, W / 2, K0, K1 - 0.66, 0, 0.1, SHADOWLINE)
box("worktop", kx - 0.03, W / 2, K0, K1 - 0.66, 0.88, 0.92, WORKTOP)
for k in range(int((K1 - 0.66 - K0) / 0.6) + 1):   # door gaps and handles
    yy = K0 + k * 0.6
    box("gap", kx - 0.002, kx, yy - 0.004, yy + 0.004, 0.1, 0.88, SHADOWLINE)
    box("knob", kx - 0.03, kx, yy + 0.25, yy + 0.35, 0.78, 0.8, STEEL)
box("sink", kx + 0.08, kx + 0.5, 1.45, 2.05, 0.86, 0.925, STEEL)
box("tap", kx + 0.52, kx + 0.56, 1.73, 1.77, 0.92, 1.2, STEEL)
box("tap", kx + 0.38, kx + 0.56, 1.73, 1.77, 1.17, 1.2, STEEL)
box("hob", kx + 0.06, kx + 0.56, 2.55, 3.15, 0.92, 0.93, HOB)
box("wallcabs", W / 2 - 0.35, W / 2, K0, K1 - 0.66, 1.5, 2.2, CABINET)
for k in range(int((K1 - 0.66 - K0) / 0.6) + 1):
    box("gap", W / 2 - 0.352, W / 2 - 0.35, K0 + k * 0.6 - 0.004, K0 + k * 0.6 + 0.004, 1.5, 2.2, SHADOWLINE)
box("fridge", kx, W / 2, K1 - 0.64, K1, 0, 1.95, CABINET)
box("fridge_gap", kx - 0.002, kx, K1 - 0.64, K1, 1.2, 1.21, SHADOWLINE)
box("fridge_handle", kx - 0.04, kx, K1 - 0.12, K1 - 0.09, 0.9, 1.5, STEEL)
solids.append({"name": "kitchen", "x": round(kx + KD / 2, 3), "z": round(-(K0 + K1) / 2, 3), "hx": round(KD / 2, 3), "hz": round((K1 - K0) / 2, 3), "top": 0.92})

# the dining table, for meetings: six chairs round it, a lamp above
TX, TY = -1.25, 3.3   # off the line from the front door into the room
place("table", TX, TY, "+x")
chairs = [(TX - 1.0, TY - 0.55, "+x"), (TX - 1.0, TY + 0.55, "+x"), (TX + 1.0, TY - 0.55, "-x"), (TX + 1.0, TY + 0.55, "-x"),
          (TX, TY - 1.45, "+y"), (TX, TY + 1.45, "-y")]
for cx, cy, f in chairs:
    place("chair", cx, cy, f, seat=[(0, 0)])
place("lamp", TX, TY, "+y", z=H - 0.95, solid=False)
place("plant", TX, TY + 0.3, "+y", z=0.88, solid=False)
lights.append([TX, H - 0.65, -TY])

# the living room at the back: the TV on the left wall, the sofa facing it, an armchair, a rug,
# a coffee table, shelves on the right-hand wall and a side table with a plant
LY = 6.4
box("rug", -1.9, 0.6, LY - 1.3, LY + 1.3, 0, 0.012, RUG)
box("tvunit", -W / 2, -W / 2 + 0.42, LY - 0.85, LY + 0.85, 0, 0.45, TVWOOD)
box("tv", -W / 2 + 0.12, -W / 2 + 0.17, LY - 0.62, LY + 0.62, 0.75, 1.47, SCREEN)
box("tvstand", -W / 2 + 0.1, -W / 2 + 0.22, LY - 0.15, LY + 0.15, 0.45, 0.47, SCREEN)
box("tvneck", -W / 2 + 0.14, -W / 2 + 0.16, LY - 0.04, LY + 0.04, 0.47, 0.76, SCREEN)
solids.append({"name": "tvunit", "x": round(-W / 2 + 0.21, 3), "z": round(-LY, 3), "hx": 0.21, "hz": 0.85, "top": 0.45})
place("coffee", -0.85, LY, "+x")
place("sofa", 0.75, LY, "-x", seat=[(0, -0.38), (0, 0.38)])
place("pillows", 0.85, LY, "-x", z=0.42, solid=False)
place("armchair", -0.9, LY + 1.25, "-y", seat=[(0, 0)])
place("side", 0.8, LY + 1.25, "-x")
place("plant", 0.8, LY + 1.25, "+y", z=0.55, solid=False)
place("shelves", W / 2 - 0.22, D - 1.0, "-x")
place("picture", W / 2 - 0.03, LY - 1.2, "+x", z=1.25, solid=False)
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
for img in bpy.data.images:   # at most TEX pixels: the house is seen from a few metres
    if img.size[0] > TEX: img.scale(TEX, max(1, round(img.size[1] * TEX / img.size[0])))
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True, export_lights=False, export_cameras=False,
                          export_image_format="JPEG", export_jpeg_quality=82)
json.dump({"size": [W, D, H], "solids": solids, "seats": seats, "lights": lights}, open(OUT_JSON, "w"), indent=1)
tris = sum(len(p.vertices) - 2 for o in bpy.data.objects for p in o.data.polygons)
print("WROTE", OUT, os.path.getsize(OUT), "bytes,", len(bpy.data.objects), "meshes,", tris, "triangles;", len(solids), "solids,", len(seats), "seats")
