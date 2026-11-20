# Game-ready player personas (Mixamo or Rigify skeletons) from downloaded glTF characters (data/blenderkit/<name>/<name>.glb).
# Keeps the meshes and skeleton, drops the source animations (the game uses its own idle/walk/run),
# shrinks every texture to at most 1024 px and writes web/models/persona_<name>.glb.
# Usage: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/personas.py -- zuri [...]
import bpy, sys, os
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAXPX = 1024

# Rigify rigs (MakeHuman-style characters): keep only the deform (DEF-) bones, parent each one to the
# nearest DEF bone above it (Rigify hangs some on helper ORG bones the game never moves), and give
# the main ones Mixamo names so the shared clips find them.
SIDE = {'L': 'Left', 'R': 'Right'}
LIMB = {'shoulder': 'Shoulder', 'upper_arm': 'Arm', 'forearm': 'ForeArm', 'hand': 'Hand',
        'thigh': 'UpLeg', 'shin': 'Leg', 'foot': 'Foot', 'toe': 'ToeBase'}
FINGER = {'thumb': 'Thumb', 'f_index': 'Index', 'f_middle': 'Middle', 'f_ring': 'Ring', 'f_pinky': 'Pinky'}
SPINE = {'DEF-spine': 'Hips', 'DEF-spine.001': 'Spine', 'DEF-spine.002': 'Spine1', 'DEF-spine.003': 'Spine2',
         'DEF-spine.004': 'Neck', 'DEF-spine.006': 'Head'}
def mixamo_name(n):
    if n in SPINE: return SPINE[n]
    base, side = n[4:].rsplit('.', 1) if n[-2:] in ('.L', '.R') else (None, None)
    if not base: return None
    if base in LIMB: return SIDE[side] + LIMB[base]
    f, _, k = base.partition('.')
    if f in FINGER and k in ('01', '02', '03'): return SIDE[side] + 'Hand' + FINGER[f] + str(int(k))
    return None
def rigify_to_mixamo(arm):
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    def deform_parent(b):
        p = b.parent
        while p is not None:
            if p.name.startswith('DEF-') and p is not b: return p
            twin = eb.get('DEF-' + p.name.split('-', 1)[-1])
            if twin is not None and twin is not b and not is_desc(twin, b): return twin
            p = p.parent
        return None
    def is_desc(a, b):   # is a below b?
        while a is not None:
            if a is b: return True
            a = a.parent
        return False
    for b in [b for b in eb if b.name.startswith('DEF-')]:
        if b.parent is None or not b.parent.name.startswith('DEF-'):
            b.use_connect = False; b.parent = deform_parent(b)
    for b in [b for b in eb if not b.name.startswith('DEF-')]: eb.remove(b)
    bpy.ops.object.mode_set(mode='OBJECT')
    for b in arm.data.bones:   # renaming a bone also renames the meshes' vertex groups
        m = mixamo_name(b.name)
        if m: b.name = 'mixamorig:' + m
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
    arm = bpy.context.view_layer.objects.active
    if arm and 'DEF-spine' in arm.data.bones: rigify_to_mixamo(arm)
    for img in bpy.data.images:
        w, h = img.size
        if max(w, h) > MAXPX:
            s = MAXPX / max(w, h); img.scale(max(1, int(w * s)), max(1, int(h * s)))
        img.file_format = 'JPEG' if not (img.depth == 32 and img.alpha_mode != 'NONE' and 'base' not in img.name.lower()) else 'PNG'
    out = os.path.join(HERE, 'web', 'models', f'persona_{name}.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=False, export_morph=False, export_image_format='AUTO', export_jpeg_quality=80)
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == 'MESH' for p in o.data.polygons)
    print('PERSONA', name, f'{os.path.getsize(out)/1e6:.1f} MB', tris, 'tris')
