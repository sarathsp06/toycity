# Game-ready player personas from downloaded glTF characters (data/blenderkit/<name>/<name>.glb).
# Keeps the meshes and skeleton, drops the source animations (the game uses its own idle/walk/run),
# shrinks every texture to at most 1024 px and writes web/models/persona_<name>.glb.
# Usage: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/personas.py -- zuri [...]
import bpy, sys, os
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAXPX = 1024
for name in sys.argv[sys.argv.index('--') + 1:]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(HERE, 'data', 'blenderkit', name, name + '.glb'))
    for a in list(bpy.data.actions): bpy.data.actions.remove(a)
    for o in bpy.data.objects:
        if o.animation_data: o.animation_data_clear()
    # facial expression shape keys are most of the file and the game never uses them
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.data.shape_keys:
            o.shape_key_clear()
    # some downloads keep the armature rotated (Z-up) and scaled; bake that into the bones so the
    # skeleton matches our Xbot's, which is what the shared idle / walk / run clips expect
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        if o.type in ('ARMATURE', 'MESH', 'EMPTY'): o.select_set(True)
    bpy.context.view_layer.objects.active = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for img in bpy.data.images:
        w, h = img.size
        if max(w, h) > MAXPX:
            s = MAXPX / max(w, h); img.scale(max(1, int(w * s)), max(1, int(h * s)))
        img.file_format = 'JPEG' if not (img.depth == 32 and img.alpha_mode != 'NONE' and 'base' not in img.name.lower()) else 'PNG'
    out = os.path.join(HERE, 'web', 'models', f'persona_{name}.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=False, export_morph=False, export_image_format='AUTO', export_jpeg_quality=80)
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == 'MESH' for p in o.data.polygons)
    print('PERSONA', name, f'{os.path.getsize(out)/1e6:.1f} MB', tris, 'tris')
