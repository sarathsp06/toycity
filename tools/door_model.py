"""Blender (headless): a Dutch front door for web/models/door.glb, made from scratch (no source file).

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/door_model.py

Two objects, in metres, y up after export, the outside of the door facing +z:
  door_frame  the frame (jambs, head, a stone step), with its origin at the bottom middle of the opening
  door_leaf   the door itself: four raised panels, a small window, a lever handle, a letterbox and a
              number plate, with its origin on the hinge (the left edge seen from outside), so turning it
              around y opens it inwards.
Materials (the game tints 'paint' per house): paint, frame, glass, metal, stone.
"""
import os
import bpy
import bmesh
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "web", "models", "door.glb")
W, H, T = 0.94, 2.12, 0.05          # the leaf: width, height, thickness
FW, FD = 0.08, 0.12                 # frame: width of a jamb, depth into the wall

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, col, metal=0.0, rough=0.6, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1); b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha; m.blend_method = "BLEND"
    return m


M = {"paint": material("paint", (0.85, 0.85, 0.85), rough=0.45), "frame": material("frame", (0.92, 0.92, 0.9), rough=0.5),
     "glass": material("glass", (0.05, 0.07, 0.09), metal=0.3, rough=0.05, alpha=0.8),
     "metal": material("metal", (0.75, 0.72, 0.62), metal=1.0, rough=0.25), "stone": material("stone", (0.55, 0.55, 0.53), rough=0.9)}


def box(bm, mat_i, x0, x1, y0, y1, z0, z1):
    """An axis-aligned box from x0..x1 (width), y0..y1 (height), z0..z1 (out of the wall), Blender z up."""
    r = bmesh.ops.create_cube(bm, size=1.0)
    vs = r["verts"]
    bmesh.ops.scale(bm, vec=Vector((x1 - x0, z1 - z0, y1 - y0)), verts=vs)
    bmesh.ops.translate(bm, vec=Vector(((x0 + x1) / 2, -(z0 + z1) / 2, (y0 + y1) / 2)), verts=vs)
    for f in {f for v in vs for f in v.link_faces}:
        f.material_index = mat_i


def obj(name, mats, build):
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    build(bm)
    bm.to_mesh(me); bm.free()
    for k in mats:
        me.materials.append(M[k])
    o = bpy.data.objects.new(name, me); scene.collection.objects.link(o)
    return o


# Blender is z up, and -y is "out of the wall" here so that after the y-up export the outside faces +z.
def frame(bm):
    box(bm, 0, -W / 2 - FW, -W / 2, 0, H + FW, -FD / 2, FD / 2)          # left jamb
    box(bm, 0, W / 2, W / 2 + FW, 0, H + FW, -FD / 2, FD / 2)            # right jamb
    box(bm, 0, -W / 2 - FW, W / 2 + FW, H, H + FW, -FD / 2, FD / 2)      # head
    box(bm, 1, -W / 2 - 0.12, W / 2 + 0.12, -0.15, 0.0, -0.05, 0.38)     # the step


def leaf(bm):
    # everything relative to the hinge at x = 0 (the leaf runs from x = 0 to x = W)
    box(bm, 0, 0, W, 0.01, H, -T / 2, T / 2)
    for (x0, x1, y0, y1) in [(0.12, 0.44, 0.15, 0.85), (0.50, 0.82, 0.15, 0.85), (0.12, 0.44, 0.95, 1.40), (0.50, 0.82, 0.95, 1.40)]:
        box(bm, 0, x0, x1, y0, y1, T / 2, T / 2 + 0.018)                 # raised panels, outside
    box(bm, 1, 0.22, 0.72, 1.55, 1.95, -T / 2 - 0.004, T / 2 + 0.004)    # window
    box(bm, 2, 0.80, 0.84, 0.98, 1.12, T / 2, T / 2 + 0.05)              # handle: the rose
    box(bm, 2, 0.66, 0.84, 1.06, 1.09, T / 2 + 0.04, T / 2 + 0.065)      # handle: the lever
    box(bm, 2, 0.30, 0.64, 0.88, 0.92, T / 2, T / 2 + 0.012)             # letterbox
    box(bm, 2, 0.40, 0.54, 1.47, 1.52, T / 2, T / 2 + 0.008)             # the number plate


fr = obj("door_frame", ["frame", "stone"], frame)
lf = obj("door_leaf", ["paint", "glass", "metal"], leaf)
lf.location = (-W / 2, 0, 0)       # hinge on the left edge of the opening, seen from outside
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print("WROTE", OUT, os.path.getsize(OUT))
