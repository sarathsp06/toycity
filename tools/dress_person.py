"""Blender (headless) script: dress the Xbot mannequin and export web/models/person.glb.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/dress_person.py
The skeleton and its idle / walk / run animations are untouched, so motion stays identical.
- body faces get a material per zone, chosen by the bone that moves each face most:
  skin (head, neck, forearms, hands), shirt (torso, upper arms), jeans (hips, legs), shoes (feet)
- hair, eyes and nose are new meshes parented to the head bone
The character faces -Y in Blender (+Z in three.js).
"""
import os
import bpy
import bmesh
from mathutils import Vector

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "web", "models", "Xbot.glb")
OUT = os.path.join(HERE, "web", "models", "person.glb")
COL = {"skin": (0.50, 0.29, 0.19), "shirt": (0.36, 0.035, 0.03), "jeans": (0.035, 0.07, 0.16),
       "shoes": (0.75, 0.75, 0.74), "belt": (0.06, 0.035, 0.02), "hair": (0.03, 0.017, 0.01),
       "eye": (0.01, 0.01, 0.01), "eyewhite": (0.85, 0.85, 0.82)}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
for o in list(bpy.data.objects):
    if o.name.startswith("Icosphere"):
        bpy.data.objects.remove(o)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mats = {}
for k, c in COL.items():
    m = bpy.data.materials.new("toy_" + k)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*c, 1)
    bsdf.inputs["Roughness"].default_value = 0.45 if k in ("eye", "shoes") else 0.85
    mats[k] = m


def zone(bone):
    if any(s in bone for s in ("Head", "Neck", "Eye", "Hand", "Thumb", "Index", "Middle", "Ring", "Pinky", "ForeArm")):
        return "skin"
    if "Foot" in bone or "Toe" in bone:
        return "shoes"
    if "Leg" in bone or "Hips" in bone:
        return "jeans"
    return "shirt"


# ---- reshape the mannequin into slimmer human proportions (rest pose, so skinning still holds) ----
B = lambda n: arm.matrix_world @ arm.data.bones["mixamorig:" + n].head_local
hip, spine1 = B("Hips"), B("Spine1")
WAIST_Z, BELT_Z = hip.z + 0.06, hip.z + 0.09
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    names = {g.index: g.name for g in ob.vertex_groups}
    mw, inv = ob.matrix_world, ob.matrix_world.inverted()
    for v in ob.data.vertices:
        w = {names[g.group].replace("mixamorig:", ""): g.weight for g in v.groups}
        co = mw @ v.co
        k_hip = w.get("Hips", 0) + 0.6 * w.get("Spine", 0)
        k_belly = w.get("Spine", 0) + 0.7 * w.get("Spine1", 0)
        if k_hip > 0.05:     # narrower pelvis and flatter bottom
            co.x = hip.x + (co.x - hip.x) * (1 - 0.14 * min(k_hip, 1))
            co.y = hip.y + (co.y - hip.y) * (1 - 0.24 * min(k_hip, 1))
        if k_belly > 0.05:   # flatter belly and back
            co.y = spine1.y + (co.y - spine1.y) * (1 - 0.18 * min(k_belly, 1))
        hand = max(w, key=w.get, default="")
        if any(t in hand for t in ("Hand", "Thumb", "Index", "Middle", "Ring", "Pinky")):
            side = "Left" if hand.startswith("Left") else "Right"
            wrist = B(side + "Hand")
            co = wrist + (co - wrist) * 0.84   # mannequin hands are oversized
        v.co = inv @ co

for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    ob.data.materials.clear()
    order = ["skin", "shirt", "jeans", "shoes", "belt"]
    for k in order:
        ob.data.materials.append(mats[k])
    names = {g.index: g.name for g in ob.vertex_groups}
    vzone = []
    for v in ob.data.vertices:
        best = max(v.groups, key=lambda g: g.weight, default=None)
        z = zone(names[best.group]) if best else "shirt"
        wz = (ob.matrix_world @ v.co).z
        if wz < 0.115:                                # everything at ankle height and below is shoe
            z = "shoes"
        elif z in ("jeans", "shirt") and abs(wz - BELT_Z) < 0.022:
            z = "belt"
        elif z == "jeans" and wz > BELT_Z:            # shirt hangs over the waistband
            z = "shirt"
        vzone.append(z)
    for p in ob.data.polygons:
        zs = [vzone[i] for i in p.vertices]
        p.material_index = order.index(max(set(zs), key=zs.count))

# ---- garments: each is a single continuous cloth surface made from the clothed body parts.
#      The mannequin is built from separate segments with joint balls between them, so the
#      clothed parts (segments + joints) are pushed out, fused with a voxel remesh into one watertight
#      surface, smoothed, and then given the body's skin weights again (nearest-face transfer), so
#      the garment deforms with the same skeleton. The body under the clothes is then removed.
def ctx(obj):
    bpy.ops.object.select_all(action="DESELECT"); obj.select_set(True); bpy.context.view_layer.objects.active = obj

bodies = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Beta_")]
src = []
for o in bodies:
    c = o.copy(); c.data = o.data.copy(); bpy.context.collection.objects.link(c); src.append(c)
ctx(src[0])
for c in src[1:]:
    c.select_set(True)
bpy.ops.object.join()
skin_src = src[0]; skin_src.name = "skin_source"
for m in list(skin_src.modifiers):
    skin_src.modifiers.remove(m)

# (name, body materials it covers, push out, voxel size, smoothing passes)
# trouser legs are built one side at a time (x sign), otherwise the remesh fuses the knees together
GARMENTS = [("tshirt", {"toy_shirt"}, 0.016, 0.011, 8, 0),
            ("trousers_l", {"toy_jeans", "toy_belt"}, 0.012, 0.011, 8, 1), ("trousers_r", {"toy_jeans", "toy_belt"}, 0.012, 0.011, 8, -1),
            ("trainers", {"toy_shoes"}, 0.012, 0.009, 4, 0)]
import time
MATOF = {"tshirt": "shirt", "trousers_l": "jeans", "trousers_r": "jeans", "trainers": "shoes"}
for name, keep, push, voxel, passes, side in GARMENTS:
    t0 = time.time(); print("GARMENT", name, flush=True)
    g = skin_src.copy(); g.data = skin_src.data.copy(); g.name = name
    U = 1 / g.matrix_world.to_scale().x   # metres -> mesh units (the mannequin is modelled in cm)
    bpy.context.collection.objects.link(g)
    bm = bmesh.new(); bm.from_mesh(g.data)
    mw = g.matrix_world
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if g.data.materials[f.material_index].name not in keep
                               or (side and (mw @ f.calc_center_median()).x * side < -0.004)], context="FACES")
    bm.to_mesh(g.data); bm.free()
    g.vertex_groups.clear()
    ctx(g)
    # open segments (tubes) have no inside for the voxel remesh to fill: give them thickness first
    th = g.modifiers.new("shell", "SOLIDIFY"); th.thickness = 0.02 * U; th.offset = 0
    bpy.ops.object.modifier_apply(modifier=th.name)
    r = g.modifiers.new("fuse", "REMESH"); r.mode = "VOXEL"; r.voxel_size = voxel * U; r.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=r.name)
    print("  remeshed", len(g.data.vertices), round(time.time() - t0, 1), flush=True)
    sm = g.modifiers.new("drape", "SMOOTH"); sm.factor = 0.8; sm.iterations = passes
    bpy.ops.object.modifier_apply(modifier=sm.name)
    # some mannequin segments have inward normals, so push only after the remesh has produced a
    # clean outward-facing surface
    bm = bmesh.new(); bm.from_mesh(g.data); bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * push * U
    bm.to_mesh(g.data); bm.free()
    dec = g.modifiers.new("lighter", "DECIMATE"); dec.ratio = 0.35
    bpy.ops.object.modifier_apply(modifier=dec.name)
    g.data.materials.clear(); g.data.materials.append(mats[MATOF[name]])
    # skin weights from the body
    dt = g.modifiers.new("weights", "DATA_TRANSFER"); dt.object = skin_src
    dt.use_vert_data = True; dt.data_types_verts = {"VGROUP_WEIGHTS"}; dt.vert_mapping = "POLYINTERP_NEAREST"
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    # blend weights across knees, elbows and the waist so the cloth bends instead of tearing
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_smooth(group_select_mode="ALL", factor=0.6, repeat=12, expand=0.2)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    print("  weights", len(g.vertex_groups), round(time.time() - t0, 1), flush=True)
    am = g.modifiers.new("Armature", "ARMATURE"); am.object = arm
    g.parent = arm
    bpy.ops.object.shade_smooth()

# the body under the clothes is no longer needed
covered = {"toy_shirt", "toy_jeans", "toy_belt", "toy_shoes"}
for ob in bodies:
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if ob.data.materials[f.material_index].name in covered], context="FACES")
    bm.to_mesh(ob.data); bm.free()
bpy.data.objects.remove(skin_src)
surf = next(o for o in bodies if o.name.startswith("Beta_Surface"))

# a denim and cotton look: slightly different roughness, darker seams come from the hem edges
mats["jeans"].node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.95
mats["shirt"].node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

# ---- head attachments, built in world space at rest pose ----
le = arm.matrix_world @ arm.data.bones["mixamorig:LeftEye"].head_local
re = arm.matrix_world @ arm.data.bones["mixamorig:RightEye"].head_local
head_base = arm.matrix_world @ arm.data.bones["mixamorig:Head"].head_local
top = arm.matrix_world @ arm.data.bones["mixamorig:HeadTop_End"].head_local
cz = (head_base.z + top.z) / 2 + 0.01
centre = Vector((0, (le.y + top.y) / 2 + 0.035, cz))
parts = []

# hair: a squashed sphere shell over the top and back of the head, with a fringe at the front
bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=20, radius=1.0)
for v in bm.verts:
    v.co = Vector((v.co.x * 0.124, v.co.y * 0.138, v.co.z * 0.118)) + centre
# keep the back and sides down to the nape, cut a hairline above the eyes at the front
kill = [v for v in bm.verts if v.co.z < head_base.z - 0.005 or (v.co.y < le.y + 0.05 and v.co.z < le.z + 0.04)
        or (v.co.y < centre.y and v.co.z < le.z + 0.005)]
bmesh.ops.delete(bm, geom=kill, context="VERTS")
me = bpy.data.meshes.new("hair"); bm.to_mesh(me); bm.free()
hair = bpy.data.objects.new("hair", me); bpy.context.collection.objects.link(hair)
hair.data.materials.append(mats["hair"])
sol = hair.modifiers.new("thick", "SOLIDIFY"); sol.thickness = 0.012
parts.append(hair)

def blob(name, loc, r, mat, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=16, ring_count=10)
    o = bpy.context.active_object; o.name = name; o.scale = scale
    o.data.materials.append(mats[mat]); parts.append(o); return o

# the face surface sits in front of the eye bones: find its depth at eye and nose height
W = [surf.matrix_world @ v.co for v in surf.data.vertices]
def front(x, z, tol=0.012):
    ys = [w.y for w in W if abs(w.x - x) < tol and abs(w.z - z) < tol]
    return min(ys) if ys else le.y - 0.02
for e, n in ((le, "eye_l"), (re, "eye_r")):
    fy = front(e.x, e.z)
    blob(n + "_white", Vector((e.x, fy + 0.002, e.z)), 0.017, "eyewhite", (1, 0.45, 0.8))
    blob(n, Vector((e.x, fy - 0.004, e.z)), 0.008, "eye", (1, 0.6, 1))
nz = le.z - 0.035
blob("nose", Vector((0, front(0, nz) - 0.006, nz)), 0.014, "skin", (0.75, 1.0, 1.25))
blob("mouth", Vector((0, front(0, le.z - 0.07) - 0.001, le.z - 0.07)), 0.016, "eye", (1.5, 0.3, 0.25))

# parent attachments to the head bone without moving them
bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
arm.data.bones.active = arm.data.bones["mixamorig:Head"]
bpy.ops.object.mode_set(mode="OBJECT")
for p in parts:
    mw = p.matrix_world.copy()
    p.parent = arm; p.parent_type = "BONE"; p.parent_bone = "mixamorig:Head"
    p.matrix_world = mw

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_animations=True, export_apply=True,
                          export_animation_mode="ACTIONS", export_yup=True)
print("WROTE", OUT, os.path.getsize(OUT))
