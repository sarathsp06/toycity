"""Blender: render web/models/person.glb mid-walk from front, side and back to a PNG.
Run: Blender -b --factory-startup -P tools/preview_person.py -- OUT.png"""
import bpy, os, sys, math
from mathutils import Vector
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
for k, (x, rz) in enumerate([(-1.0, 0), (0, math.pi / 2), (1.0, math.pi)]):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(HERE, "web", "models", "person.glb"))
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    arm.location.x = x; arm.rotation_euler = (math.pi / 2, 0, rz)
    arm.animation_data_create(); arm.animation_data.action = bpy.data.actions.get("walk") or next(a for a in bpy.data.actions if "walk" in a.name)
sc = bpy.context.scene; sc.frame_set(9)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.location = (0, -6.5, 1.0); cam.rotation_euler = (math.radians(90), 0, 0); cam.data.lens = 50
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), 0, math.radians(-30)); sc.collection.objects.link(sun)
sc.world = bpy.data.worlds.new("w"); sc.world.use_nodes = True; sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.68, 0.8, 1); sc.world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
bpy.ops.mesh.primitive_plane_add(size=20)
sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = 1200, 700
sc.view_settings.view_transform = "Standard"
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
print("RENDERED", out)
