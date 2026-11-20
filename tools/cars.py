"""Blender (headless): turn street vehicles from the Kenney Car Kit (CC0, assets/kenney-car-kit)
into web/models/cars.glb at real-world size, one joined mesh per vehicle.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/cars.py
Each vehicle: wheels and body joined, length along +X, centred on its footprint, ground at y = 0,
scaled to real length, width and height. They keep the kit's shared colour atlas, so all cars draw with one texture.
"""
import os
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(HERE, "assets", "kenney-car-kit")
OUT = os.path.join(HERE, "web", "models", "cars.glb")
# vehicle -> real length, width, height in metres (the kit is cartoon-proportioned: much wider and
# taller than real cars, so each axis is scaled to typical real dimensions)
CARS = {"sedan": (4.6, 1.8, 1.45), "hatchback-sports": (4.1, 1.78, 1.4), "suv": (4.7, 1.9, 1.7),
        "suv-luxury": (4.9, 1.95, 1.75), "van": (5.1, 2.0, 2.0), "taxi": (4.6, 1.8, 1.5),
        "delivery": (5.4, 2.05, 2.6), "police": (4.6, 1.8, 1.5), "sedan-sports": (4.5, 1.85, 1.3)}

bpy.ops.wm.read_factory_settings(use_empty=True)
from mathutils import Matrix
done = []
for name, (length, width, height) in CARS.items():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, name + ".glb"))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    # bake every part's world transform into its vertices, so joining cannot shift anything
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
    for o in new:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    car = bpy.context.active_object; car.name = name
    me = car.data
    def ext():
        xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
        return min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)
    x0, x1, y0, y1, z0, z1 = ext()
    if (y1 - y0) > (x1 - x0):                       # length along Y -> rotate to +X (front at -Y -> +X)
        me.transform(Matrix.Rotation(1.5707963, 4, "Z"))
        x0, x1, y0, y1, z0, z1 = ext()
    S = Matrix.Diagonal((length / (x1 - x0), width / (y1 - y0), height / (z1 - z0), 1))
    me.transform(S @ Matrix.Translation(Vector((-(x0 + x1) / 2, -(y0 + y1) / 2, -z0))))
    x0, x1, y0, y1, z0, z1 = ext()
    print("CAR", name, round(x1 - x0, 2), "x", round(y1 - y0, 2), "x", round(z1 - z0, 2))
    done.append(car)
    car.hide_set(False)
for c in done:
    c.location = (0, 0, 0)

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print("WROTE", OUT, os.path.getsize(OUT))
