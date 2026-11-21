#!/usr/bin/env node
// Makes web/models/anims.glb: motion-capture clips (jump, sit, drive, fall, knock...) for the person,
// taken from the Quaternius Universal Animation Library (CC0, data/quaternius/...) and retargeted
// onto person.glb's Mixamo-named skeleton with the same world-space retarget the game uses per
// persona (web/avatar.js retarget()). Runs headless Chromium (playwright-core) against the dev
// server, because GLTFLoader / GLTFExporter want a browser.
//
//   python3 tools/serve.py 8765 &        # the dev server, serving web/
//   node tools/retarget_anims.mjs        # writes web/models/anims.glb and /tmp/anim-check/<clip>.jpg
//
// The checks in /tmp/anim-check show each clip at four moments, the person seen from the front left.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data/quaternius/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb');
const OUT = path.join(ROOT, 'web/models/anims.glb');
const CHECK = process.env.CHECK_DIR || '/tmp/anim-check';
const SERVER = process.env.SERVER || 'http://localhost:8765';
const CHROME = process.env.CHROME || path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

// Quaternius (Unreal names) -> Mixamo. Fingers too, so the hands curl where the clip says so.
const BONES = { pelvis: 'Hips', spine_01: 'Spine', spine_02: 'Spine1', spine_03: 'Spine2', neck_01: 'Neck', Head: 'Head' };
for (const [s, S] of [['l', 'Left'], ['r', 'Right']]) {
  Object.assign(BONES, { ['clavicle_' + s]: S + 'Shoulder', ['upperarm_' + s]: S + 'Arm', ['lowerarm_' + s]: S + 'ForeArm', ['hand_' + s]: S + 'Hand',
    ['thigh_' + s]: S + 'UpLeg', ['calf_' + s]: S + 'Leg', ['foot_' + s]: S + 'Foot', ['ball_' + s]: S + 'ToeBase' });
  for (const [f, F] of [['thumb', 'Thumb'], ['index', 'Index'], ['middle', 'Middle'], ['ring', 'Ring'], ['pinky', 'Pinky']])
    for (const k of [1, 2, 3]) BONES[`${f}_0${k}_${s}`] = `${S}Hand${F}${k}`;
}
// our clip name -> the library's
const CLIPS = { jump_start: 'Jump_Start', jump_loop: 'Jump_Loop', jump_land: 'Jump_Land', hit: 'Hit_Chest', fall: 'Death01', roll: 'Roll',
  sit_enter: 'Sitting_Enter', sit_idle: 'Sitting_Idle_Loop', sit_exit: 'Sitting_Exit', sit_talk: 'Sitting_Talking_Loop', drive: 'Driving_Loop',
  talk: 'Idle_Talking_Loop', knock: 'Interact', crouch: 'Crouch_Idle_Loop', dance: 'Dance_Loop' };

async function playwright() {
  for (const p of [path.join(os.homedir(), 'node_modules/playwright-core/index.mjs'), path.join(ROOT, 'tools/node_modules/playwright-core/index.mjs')])
    if (fs.existsSync(p)) return import(p);
  throw new Error('playwright-core not found in ~/node_modules or tools/node_modules');
}
const PAGE = `<!doctype html><meta charset="utf-8"><script type="importmap">{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/" } }</script>
<body style="margin:0;background:#99bbbb"></body>`;

const { chromium } = await playwright();
const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 420 } });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[page error]', e.message));
  await page.route('**/__src.glb', r => r.fulfill({ body: fs.readFileSync(SRC), contentType: 'model/gltf-binary' }));
  await page.route('**/__page', r => r.fulfill({ body: PAGE, contentType: 'text/html' }));
  await page.goto(SERVER + '/__page');
  const result = await page.evaluate(async ({ BONES, CLIPS }) => {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const { retarget } = await import('/avatar.js');
    const L = new GLTFLoader();
    const [src, tgt] = await Promise.all([L.loadAsync('/__src.glb'), L.loadAsync('/models/person.glb')]);
    // give the library's bones (and its tracks) our names, so the retarget pairs them by name
    src.scene.traverse(o => { if (o.isBone && BONES[o.name]) o.name = 'mixamorig' + BONES[o.name]; });
    for (const a of src.animations) for (const t of a.tracks) { const [b, prop] = t.name.split('.'); if (BONES[b]) t.name = 'mixamorig' + BONES[b] + '.' + prop; }
    const target = tgt.scene; target.updateMatrixWorld(true);
    const clips = [];
    for (const [name, from] of Object.entries(CLIPS)) {
      const clip = src.animations.find(a => a.name === from); if (!clip) throw new Error('no clip ' + from);
      const c = retarget(src, target, clip, { fps: 30, fingers: true }); c.name = name; clips.push(c);
    }
    // the file: person.glb's node tree without its meshes (the clips bind to person.glb's bones by name)
    const skel = new THREE.Group(); skel.name = 'person_skeleton';
    const arm = target.children.find(o => o.name === 'Armature') || target;
    const bare = new THREE.Object3D(); bare.name = arm.name; bare.position.copy(arm.position); bare.quaternion.copy(arm.quaternion); bare.scale.copy(arm.scale);
    const copyBones = (from, to) => { for (const c of from.children) if (c.isBone) { const b = new THREE.Object3D(); b.name = c.name; b.position.copy(c.position); b.quaternion.copy(c.quaternion); b.scale.copy(c.scale); to.add(b); copyBones(c, b); } };
    copyBones(arm, bare); skel.add(bare);
    const glb = await new Promise((ok, err) => new GLTFExporter().parse(skel, ok, err, { binary: true, animations: clips }));
    const u8 = new Uint8Array(glb); let bin = ''; for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    const b64 = btoa(bin);
    const info = clips.map(c => `${c.name}: ${c.duration.toFixed(2)} s, ${c.tracks.length} tracks`);
    return { b64, info, size: glb.byteLength };
  }, { BONES, CLIPS });
  fs.writeFileSync(OUT, Buffer.from(result.b64, 'base64'));
  console.log(`wrote ${OUT} (${(result.size / 1024).toFixed(0)} KB)`);
  for (const l of result.info) console.log('  ' + l);

  // ---- check: the person plays every clip from the file, four moments each, side by side ----
  fs.mkdirSync(CHECK, { recursive: true });
  await page.route('**/__anims.glb', r => r.fulfill({ body: fs.readFileSync(OUT), contentType: 'model/gltf-binary' }));
  await page.evaluate(async () => {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const L = new GLTFLoader();
    const [person, anims] = await Promise.all([L.loadAsync('/models/person.glb'), L.loadAsync('/__anims.glb')]);
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(300, 420); renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x99bbbb);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(3, 6, 4); sun.castShadow = true; scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ color: 0x8a9 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    const grid = new THREE.GridHelper(8, 16, 0x446, 0x557); scene.add(grid);
    // +Z arrow on the floor: the way the idle clip faces
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.02, 0), 1, 0xdd3333, 0.25, 0.15));
    const model = person.scene; model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } }); scene.add(model);
    const camera = new THREE.PerspectiveCamera(40, 300 / 420, 0.1, 50); camera.position.set(-2.6, 1.7, 3.0); camera.lookAt(0, 0.85, 0);
    const mixer = new THREE.AnimationMixer(model);
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 420; const ctx = canvas.getContext('2d');
    window.__shots = {}; window.__hips = {};
    const hips = model.getObjectByName('mixamorigHips');
    for (const clip of anims.animations) {
      // the hips' height through the clip (sitting height, when a jump leaves the ground...)
      const a0 = mixer.clipAction(clip); a0.play();
      window.__hips[clip.name] = [...Array(11)].map((_, i) => { mixer.setTime(0); mixer.setTime(clip.duration * i / 10); model.updateMatrixWorld(true); return +hips.getWorldPosition(new THREE.Vector3()).y.toFixed(2); });
      a0.stop(); mixer.uncacheClip(clip);
      const a = mixer.clipAction(clip); a.play(); a.setLoop(THREE.LoopOnce); a.clampWhenFinished = true;
      ctx.fillStyle = '#99bbbb'; ctx.fillRect(0, 0, 1200, 420);
      [0.05, 0.35, 0.65, 0.98].forEach((f, i) => {
        mixer.setTime(0); mixer.setTime(clip.duration * f); renderer.render(scene, camera);
        ctx.drawImage(renderer.domElement, i * 300, 0);
        ctx.fillStyle = '#000'; ctx.font = '16px sans-serif'; ctx.fillText(`${clip.name} @ ${(clip.duration * f).toFixed(2)} s`, i * 300 + 8, 20);
      });
      a.stop(); mixer.uncacheClip(clip);
      window.__shots[clip.name] = canvas.toDataURL('image/jpeg', 0.85);
    }
  });
  const shots = await page.evaluate(() => window.__shots), hips = await page.evaluate(() => window.__hips);
  for (const [n, h] of Object.entries(hips)) console.log(`  hips y, ${n}: ${h.join(' ')}`);
  for (const [n, d] of Object.entries(shots)) fs.writeFileSync(path.join(CHECK, n + '.jpg'), Buffer.from(d.split(',')[1], 'base64'));
  console.log(`checks in ${CHECK}: ${Object.keys(shots).join(', ')}`);
} finally { await browser.close(); }
