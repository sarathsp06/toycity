// Streamed city: loads pre-built 500 m squares around the player and drops the ones left behind.
//   near squares (< NEAR m away): LoD 2.2 buildings, every surface, doors, windows, cars, trees, lamps,
//                                 collision and labels, 2048 px aerial photo
//   far squares  (< FAR m away):  LoD 1.2 blocks on a 512 px aerial photo
// Files are fetched, un-gzipped and decoded in a worker; the main thread only creates GPU buffers,
// and applies at most a few milliseconds of that per frame so walking never stutters.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as BU from 'three/addons/utils/BufferGeometryUtils.js';
import * as TX from './textures.js';
import { loadAvatar, myLook, poseLayer } from './avatar.js';
import { createSolids, footprintsOf, PERSON } from './solids.js';
import { createDriving, makeCar, footprintOf, FRONT, PASSENGER, seatLocal } from './vehicle.js';
import { createParked, STRIDE } from './parked.js';
import { createGrid, squareKey, getBit, setBit, newBitmap, SIDE, eachCell } from './grid.js';
import { createPlayerMode, FALL_DOWN } from './player.js';
import { POSE, SEATED, isPassenger, carModel } from './mp/state.js';
import { sitOffset } from './mp/players.js';
import { createWalker, STEP } from './walker.js';
import { rng } from './ambient.js';
import { createAutopilot } from './autopilot.js';
import { createTraffic, COUNT as TRAFFIC_N } from './traffic.js';
import { createPeds, COUNT as PEDS_N } from './peds.js';
import { createHomes } from './home.js';
import { createInterior, INDOORS, STEP_IN, BODY, blobMesh } from './interior.js';
import { createRadio, mountRadio } from './radio.js';
import { createNav, mountNav } from './nav.js';
import { createBirds } from './birds.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const params = new URLSearchParams(location.search);
// ?place=<id> picks a place from places.json (the front page lists them): which region to stream and
// where to stand. Several places can share one region; Rotterdam and Barendrecht are one walkable world.
// ?region= still works on its own for development regions.
const places = await fetch('./places.json').then(r => r.json()).catch(() => []);
const spot = places.find(p => p.id === params.get('place')) || (!params.get('region') && places[0]) || null;
const slug = params.get('region') || spot?.region || 'rotterdam';
// The page itself used to be cached for a day while the scripts were always fresh, so a browser could
// run new scripts on an old page (missing buttons) and stop at the loading screen. Detect that and
// fetch the page once more, bypassing the cache.
if (!document.getElementById('menubtn') && !sessionStorage.getItem('toycity.refreshed')) {
  sessionStorage.setItem('toycity.refreshed', '1');
  params.set('fresh', Date.now()); location.replace(location.pathname + '?' + params + location.hash);   // keeps ?meet= and friends
}
const base = new URL(`./regions/${slug}/`, location.href);
const progress = (f, t) => window.loadProgress?.(f, t);
progress(0.05, 'Reading the map');
const info = await (await fetch(new URL('tiles.json', base))).json();
if (spot) { info.title = spot.name; if (spot.start) info.start = spot.start; }
const T = info.tile, QQ = info.quant;
const HAVE = new Set(info.squares.map(([i, j]) => squareKey(i, j)));
const CHARS = '0123456789abcdefghijklmnopqrstuvwxyz-/ ';
document.getElementById('title').textContent = info.title;
document.title = 'Toy City · ' + info.title;
{ const n = document.querySelector('#loading .name'); if (n) n.textContent = info.title; }

// one world origin in RD metres; three.js x = east, z = -north
const sx = info.start ? info.start.x : info.squares.reduce((s, [i]) => s + (i + 0.5) * T, 0) / info.squares.length;
const sy = info.start ? info.start.y : info.squares.reduce((s, [, j]) => s + (j + 0.5) * T, 0) / info.squares.length;
const ORX = Math.round(sx), ORY = Math.round(sy);
const grid = createGrid(ORX, ORY, T), { toRD, fromRD } = grid;   // RD metres, square keys, 0.5 m bitmaps (grid.js)

// ---------- quality presets ----------
const QUALITY = {
  low: { near: 120, far: 800, horizon: 3000, px: 1, shadow: 1024 },
  mid: { near: 200, far: 1100, horizon: 4500, px: 1.5, shadow: 2048 },
  high: { near: 320, far: 1500, horizon: 6000, px: 2, shadow: 4096 },
};
let Q = QUALITY[params.get('quality') || 'mid'];
document.getElementById('quality').value = params.get('quality') || 'mid';

// ---------- renderer, sky, light ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.px));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;   // redrawn when something in the shadows moved (see frame())
let shadowDirty = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9ccbe8, 400, Q.far);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, Math.max(4000, Q.horizon + 500));

const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
const sc = sun.shadow.camera; sc.near = 10; sc.far = 1200;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(-250, 380, 200);
const hemi = new THREE.HemisphereLight(0xdff0ff, 0x8a9a7a, 1.4), amb = new THREE.AmbientLight(0xffffff, 0.35);
scene.add(hemi, amb);
// The sky is baked, not drawn: the atmosphere shader (sunlight scattered per pixel) runs once into a
// cubemap when the time of day changes, and every frame just samples that cube for the background
// and, blurred, for the reflections on cars and windows. Drawing the shader directly would cost the
// same scattering maths for half the screen on every frame.
const sky = new Sky(); sky.scale.setScalar(5000);
const skyScene = new THREE.Scene(); skyScene.add(sky);
let skyRT = null;
{
  const u = sky.material.uniforms; u.turbidity.value = 4; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(SUN_OFFSET).normalize();
}
function bakeSky() {
  if (!skyRT) skyRT = new THREE.WebGLCubeRenderTarget(Q.shadow >= 4096 ? 1024 : 512, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  new THREE.CubeCamera(1, 20000, skyRT).update(renderer, skyScene);
  scene.background = skyRT.texture;
  const pm = new THREE.PMREMGenerator(renderer), old = scene.environment;
  scene.environment = pm.fromCubemap(skyRT.texture).texture; pm.dispose(); old?.dispose();
}

// ---------- shared materials (one per kind for the whole city) ----------
const std = (o = {}) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });
const perMetre = t => { t.repeat.set(1 / t.userData.size[0], 1 / t.userData.size[1]); return t; };
// ground groups carry no uv; texture coordinates are the square-local metres, computed in the shader
function worldUV(m) {
  m.onBeforeCompile = s => {
    s.vertexShader = s.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      #ifdef USE_MAP
      vMapUv = ( mapTransform * vec3( position.x * ${QQ.q.toFixed(4)} - ${QQ.ox.toFixed(1)}, -( position.z * ${QQ.q.toFixed(4)} - ${QQ.oz.toFixed(1)} ), 1.0 ) ).xy;
      #endif`);
  };
  m.customProgramCacheKey = () => 'worldUV';
  return m;
}
const M = {};
for (const k of Object.keys(TX.SURFACES)) M['surf:' + k] = worldUV(std({ map: perMetre(TX.SURFACES[k](renderer)), roughness: k === 'road' ? 0.8 : 0.95 }));
// Water: a dark canal green-blue that mirrors the sky (scene.environment), with small ripples made in
// the shader from world position and time, so there is no texture to load and no uv needed
const waterTime = { value: 0 };
M.water = std({ color: 0x24434d, roughness: 0.04, metalness: 0, envMapIntensity: 1.6 });
M.water.onBeforeCompile = s => {
  s.uniforms.uTime = waterTime;
  s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vWater;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWater = (modelMatrix * vec4(transformed, 1.0)).xz;');
  s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
    varying vec2 vWater; uniform float uTime;
    // the slope of a few crossing wave trains: d/dx and d/dz of sum(a sin(k.p - w t))
    vec2 waves(vec2 p) {
      vec2 g = vec2(0.0);
      g += 0.050 * vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 1.3 - uTime * 1.1);
      g += 0.040 * vec2(-0.5, 0.9) * cos(dot(p, vec2(-0.5, 0.9)) * 2.1 - uTime * 1.6);
      g += 0.025 * vec2(0.95, -0.3) * cos(dot(p, vec2(0.95, -0.3)) * 4.3 - uTime * 2.3);
      g += 0.015 * vec2(-0.2, -1.0) * cos(dot(p, vec2(-0.2, -1.0)) * 7.9 - uTime * 3.1);
      return g;
    }`).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    { vec2 g = waves(vWater) * smoothstep(250.0, 30.0, length(vViewPosition));
      normal = normalize(normal + (viewMatrix * vec4(-g.x, 0.0, -g.y, 0.0)).xyz); }`);
};
M.water.customProgramCacheKey = () => 'water';
M.hedge = std({ map: perMetre(TX.SURFACES.plants(renderer)), color: 0xb8d0a8 });
M.fhedge = std({ map: perMetre(TX.SURFACES.plants(renderer)), color: 0xc0d8b0 });
M.gwall = std({ map: perMetre(TX.wallTexture(renderer, ...TX.WALLS[0])) });
M.fence = std({ map: perMetre(TX.plankTexture(renderer)), side: THREE.DoubleSide });
M.plates = std({ map: TX.plateAtlas(CHARS), roughness: 0.5 });
TX.WALLS.forEach((w, i) => { M['wall' + i] = std({ map: TX.wallTexture(renderer, ...w), vertexColors: true, roughness: 0.85 }); });
M.farwall = std({ map: TX.wallTexture(renderer, ...TX.WALLS[0]), roughness: 0.9 });
const glassTex = TX.windowTexture(renderer, false), litTex = TX.windowTexture(renderer, true);
M.win = std({ map: glassTex, roughness: 0.25, metalness: 0.1 });
M.winlit = std({ map: glassTex, roughness: 0.25, emissiveMap: litTex, emissive: 0xffffff, emissiveIntensity: 0 });
M.door = std({ map: TX.doorTexture(renderer), roughness: 0.6 });
const NO_SHADOW_CAST = new Set(['water', 'plates']);

// ---------- shared instance shapes ----------
const SHAPES = {};
{
  const trunk = new THREE.CylinderGeometry(0.14, 0.22, 3.2, 7).translate(0, 1.6, 0);
  const parts = [], r = rng(11);
  for (const [ox, oy, oz, rad] of [[0, 4.6, 0, 1.9], [0.9, 4.0, 0.5, 1.4], [-0.8, 4.1, -0.4, 1.5], [0.2, 5.6, -0.3, 1.3], [-0.3, 3.8, 0.9, 1.2]]) {
    const g = new THREE.IcosahedronGeometry(rad, 1), p = g.attributes.position, seed = r() * 100;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const k = 0.88 + 0.12 * Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 - seed) + 0.06 * Math.sin(y * 4.3 + seed * 2); p.setXYZ(i, x * k + ox, y * k * 0.9 + oy, z * k + oz); }
    g.deleteAttribute('uv'); parts.push(g);
  }
  const crown = BU.mergeVertices(BU.mergeGeometries(parts)); crown.computeVertexNormals();
  SHAPES.tree = [[trunk, std({ color: 0x5b4636, roughness: 1 })], [crown, std({ color: 0xffffff, roughness: 0.95, flatShading: true }), 'leaf']];
  const pole = new THREE.CylinderGeometry(0.06, 0.09, 6, 8).translate(0, 3, 0);
  const head = new THREE.BoxGeometry(0.22, 0.12, 0.55).translate(0, 6, 0.2);
  M.lamphead = std({ color: 0x3c4146, emissive: 0xffd49a, emissiveIntensity: 0, roughness: 0.4 });
  M.pool = new THREE.MeshBasicMaterial({ map: TX.glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  SHAPES.lamp = [[pole, std({ color: 0x3c4146, roughness: 0.5, metalness: 0.6 })], [head, M.lamphead], [new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2).translate(0, 0.2, 0), M.pool, 'pool']];
  const body = BU.mergeGeometries([new THREE.BoxGeometry(4.2, 0.62, 1.74).translate(0, 0.62, 0), new THREE.BoxGeometry(0.9, 0.18, 1.7).translate(1.55, 0.98, 0),
    new THREE.CylinderGeometry(0.78, 0.98, 2.3, 4, 1).rotateY(Math.PI / 4).rotateZ(Math.PI / 2).scale(1, 0.38, 1.12).translate(-0.25, 1.2, 0)].map(g => g.toNonIndexed()));
  const glass = new THREE.CylinderGeometry(0.8, 1.0, 2.25, 4, 1).rotateY(Math.PI / 4).rotateZ(Math.PI / 2).scale(1, 0.4, 1.13).translate(-0.25, 1.21, 0);
  const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 12).rotateX(Math.PI / 2);
  const wheels = BU.mergeGeometries([[1.35, 0.8], [1.35, -0.8], [-1.35, 0.8], [-1.35, -0.8]].map(([x, z]) => wheel.clone().translate(x, 0.33, z)));
  SHAPES.car = [[body, std({ roughness: 0.35, metalness: 0.5 }), 'paint'], [glass, std({ color: 0x1d2730, roughness: 0.1, metalness: 0.6 })], [wheels, std({ color: 0x151515 })]];
  SHAPES.win = [[new THREE.PlaneGeometry(1.3, 1.35), M.win]];
  SHAPES.winlit = [[new THREE.PlaneGeometry(1.3, 1.35), M.winlit]];
  SHAPES.door = [[new THREE.PlaneGeometry(1.0, 2.2), M.door, 'paint']];
  const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
  const furn = (geo, color, o = {}) => [[geo, std({ color, roughness: 0.6, ...o })]];
  SHAPES['furn:bollard'] = furn(new THREE.CylinderGeometry(0.08, 0.1, 0.9, 10).translate(0, 0.45, 0), 0x2b2d30);
  SHAPES['furn:bin'] = furn(new THREE.CylinderGeometry(0.28, 0.26, 0.95, 14).translate(0, 0.48, 0), 0x3b5a46);
  SHAPES['furn:postbox'] = furn(box(0.5, 1.2, 0.4, 0, 0.6), 0xe06a1b);
  SHAPES['furn:recycling'] = furn(box(1.4, 1.5, 1.4, 0, 0.75), 0x56606a);
  SHAPES['furn:vending'] = furn(box(0.8, 1.8, 0.6, 0, 0.9), 0x8a2b2b);
  SHAPES['furn:bench'] = furn(BU.mergeGeometries([box(1.8, 0.08, 0.45, 0, 0.45), box(1.8, 0.4, 0.06, 0, 0.75, -0.2), box(0.08, 0.45, 0.4, -0.8, 0.22), box(0.08, 0.45, 0.4, 0.8, 0.22)]), 0x6b4a2f);
  SHAPES['furn:bikerack'] = furn(BU.mergeGeometries([-1.2, -0.4, 0.4, 1.2].map(x => new THREE.TorusGeometry(0.4, 0.03, 6, 16, Math.PI).translate(x, 0.25, 0))), 0x9aa0a6, { metalness: 0.5 });
  SHAPES['furn:busstop'] = furn(BU.mergeGeometries([box(3.4, 0.1, 1.5, 0, 2.5), box(3.4, 2.3, 0.05, 0, 1.25, -0.7), box(0.05, 2.3, 1.4, -1.7, 1.25)]), 0x8fa3ad, { transparent: true, opacity: 0.75, metalness: 0.3 });
  // charging post: grey pillar with a glowing green ring and a cable loop
  M.chargerLight = std({ color: 0x1f8a4c, emissive: 0x2bd46d, emissiveIntensity: 0.6 });
  SHAPES['furn:charger'] = [[BU.mergeGeometries([box(0.42, 1.45, 0.32, 0, 0.72), box(0.5, 0.06, 0.4, 0, 1.47)]), std({ color: 0xd9dde0, roughness: 0.4 })],
    [new THREE.CylinderGeometry(0.17, 0.17, 0.06, 16).rotateX(Math.PI / 2).translate(0, 1.15, 0.17), M.chargerLight],
    [new THREE.TorusGeometry(0.22, 0.025, 6, 20).translate(0, 0.7, 0.2), std({ color: 0x1a1a1a })]];
  SHAPES.play = furn(BU.mergeGeometries([box(0.1, 2.2, 0.1, -1.2, 1.1), box(0.1, 2.2, 0.1, 1.2, 1.1), box(2.5, 0.1, 0.1, 0, 2.2), box(0.5, 0.05, 0.25, -0.4, 0.5), box(0.5, 0.05, 0.25, 0.4, 0.5)]), 0xc6452f);
}
const PAINT = new THREE.Color();
const LEAF = [0x2f5a24, 0x3a6a2a, 0x29502a, 0x456f2e, 0x355e28];

// ---------- building meshes from a decoded square file ----------
// every group of a square fits one sphere: the square's centre, 30 m up, with room for the buildings
// that stick out over its edge (in quantised units, as the geometry is)
const Q_SPHERE = new THREE.Sphere(new THREE.Vector3((T / 2 + QQ.ox) / QQ.q, (30 + QQ.oy) / QQ.q, (-T / 2 + QQ.oz) / QQ.q), T * 0.8 / QQ.q);
function qGeo({ buf, base }, g) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(buf, base + g.pos[0], g.pos[1]), 3));
  geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Int8Array(buf, base + g.nrm[0], g.nrm[1]), 4), 3, 0, true));
  if (g.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, base + g.uv[0], g.uv[1]), 2));
  if (g.col) geo.setAttribute('color', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Uint8Array(buf, base + g.col[0], g.col[1]), 4), 3, 0, true));
  geo.setIndex(new THREE.BufferAttribute(g.i32 ? new Uint32Array(buf, base + g.idx[0], g.idx[1]) : new Uint16Array(buf, base + g.idx[0], g.idx[1]), 1));
  geo.boundingSphere = Q_SPHERE.clone();
  return geo;
}
function quantGroup() { const g = new THREE.Group(); g.position.set(-QQ.ox, -QQ.oy, -QQ.oz); g.scale.setScalar(QQ.q); return g; }
function aerialTexture(bitmap, aniso) {
  const t = new THREE.Texture(bitmap); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso; t.needsUpdate = true;
  renderer.initTexture(t);   // upload now, within the square's time budget, not inside the next render
  bitmap.close();            // the GPU has it; three.js reads the image again only on needsUpdate (or a lost context)
  return t;
}
// parked cars: real models from BlendSwap (see models/CREDITS.txt), made game-ready by
// tools/blendswap_cars.py. Each parking spot gets one model, picked by a stable hash of its position.
// Three levels by distance to the player, re-sorted a few times a second:
//   near (< CAR_NEAR m): about 30k triangles, mid (< CAR_MID m): about 5k, beyond: the simple box car.
// bump the ?v= on cars.glb when the models change: the file is cached for a day
const CAR_MIX = { suv: 12, bike: 1 };   // one SUV in many paints, and the odd motorbike (tools/blendswap_cars.py IN_GAME)
const CAR_EXTRA = ['suv_wreck'];       // loaded but never parked: what a crashed SUV turns into
const CAR_NEAR = 25, CAR_MID = 70;
function partsOf(obj) {
  const parts = []; obj.updateMatrixWorld(true);
  obj.traverse(o => { if (o.isMesh) { const geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); parts.push([geo, o.material, o.material.name.startsWith('paint') ? 'paint' : null]); } });
  return parts;
}
// cars with separate doors also come as <name>_body plus <name>_door0.. with their origin on the hinge;
// the car you drive is built from those so its doors can open (vehicle.js)
function openParts(root, name) {
  const body = root.getObjectByName(name + '_body'); if (!body) return null;
  const doors = [];
  for (let i = 0; ; i++) {
    const node = root.getObjectByName(`${name}_door${i}`); if (!node) break;
    const hinge = node.position.clone();
    const parts = partsOf(node); for (const [geo] of parts) geo.translate(-hinge.x, -hinge.y, -hinge.z);
    doors.push({ hinge, parts });
  }
  const inside = root.getObjectByName(name + '_interior');
  return { body: partsOf(body), doors, interior: inside ? partsOf(inside) : null };
}
// The models download while the first squares do (the page does not wait for them): CAR_MODELS is the
// list, filled once carsReady settles; a square's cars are placed when both are there (see instances)
progress(0.08, 'Parking the cars');
const CAR_MODELS = []; let CAR_W = 0, carsProg = 0;
const carsReady = new GLTFLoader().loadAsync(new URL('./models/cars.glb?v=view4', import.meta.url).href,
  e => { if (e.total) carsProg = Math.min(0.99, e.loaded / e.total); }).then(g => {
  for (const [name, w] of [...Object.entries(CAR_MIX), ...CAR_EXTRA.map(n => [n, 0])]) {
    const hi = g.scene.getObjectByName(name), lo = g.scene.getObjectByName(name + '_lo');
    if (!hi) continue;
    CAR_MODELS.push({ name, w, hi: partsOf(hi), lo: partsOf(lo || hi), open: openParts(g.scene, name) });
  }
  CAR_W = CAR_MODELS.reduce((s, c) => s + c.w, 0);
}).catch(e => console.warn('cars', e)).then(() => { carsProg = 1; });
function carModelAt(x, z) {
  let r = ((Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(z * 10), 19349663)) >>> 0) / 4294967296 * CAR_W;
  for (const c of CAR_MODELS) { if ((r -= c.w) < 0) return c; }
  return CAR_MODELS[0];
}
const parked = createParked();   // the squares' parked cars, and which are taken or dented (parked.js)
const CAR_SPHERE = new THREE.Sphere(new THREE.Vector3(T / 2, 0, -T / 2), T * 0.75);   // the whole square: never recomputed
function carMeshes(tile, parts, n) {
  return parts.map(([geo, mat, role]) => {
    const m = new THREE.InstancedMesh(geo, mat, n); m.count = 0; m.visible = false; m.boundingSphere = CAR_SPHERE.clone();
    m.castShadow = true; m.receiveShadow = true; m.userData.paint = role === 'paint';
    tile.group.add(m); return m;
  });
}
function carInstances(tile, data) {
  const fps = footprintsOf('car', data, tile.group.position);
  if (CAR_MODELS.length) fps.forEach((f, n) => { const m = carModelAt(data[n * 6], data[n * 6 + 2]).name; if (m === 'bike') Object.assign(f, footprintOf(m, f.x, f.z, f.yaw)); });
  parked.footprints(tile, fps);   // a car someone drove off stays off
  solids.add(tile, fps);
  if (!CAR_MODELS.length) return shapeInstances(tile, 'car', data);   // no models: the simple box car
  const cars = [];
  for (let k = 0; k < data.length; k += 6) cars.push({ k, model: carModelAt(data[k], data[k + 2]) });
  const byModel = new Map();
  for (const c of cars) (byModel.get(c.model) || byModel.set(c.model, []).get(c.model)).push(c);
  parked.add(tile, { data, groups: [], box: carMeshes(tile, SHAPES.car, cars.length), all: cars });
  for (const [model, list] of byModel) tile.cars.groups.push({ list, hi: carMeshes(tile, model.hi, list.length), lo: carMeshes(tile, model.lo, list.length) });
  updateCars(tile);
}
const carCol = new THREE.Color();
function fill(meshes, i, data, k) {
  tmpO.position.set(data[k], data[k + 1] - 0.02, data[k + 2]); tmpO.rotation.set(0, data[k + 3], 0); tmpO.scale.setScalar(1); tmpO.updateMatrix();
  for (const m of meshes) { m.setMatrixAt(i, tmpO.matrix); if (m.userData.paint) m.setColorAt(i, carCol.setHex(data[k + 5])); }
}
function finish(meshes, n) {
  for (const m of meshes) { m.count = n; m.visible = n > 0; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
}
// re-split every parked car of a square into near / mid / far by its distance to the player; true when
// anything moved between the meshes. Each car's level is kept (0 gone: driven away or a wreck stands there,
// 1 near, 2 mid, 3 box) so an unchanged square costs one pass of distances and no uploads. A square more
// than CAR_MID from the player is all boxes: not even that, unless a car was taken or wrecked meanwhile.
function updateCars(tile) {
  const c = tile.cars, { data, groups, box, all } = c, ox = tile.group.position.x, oz = tile.group.position.z;
  const px = player.position.x - ox, pz = player.position.z - oz;
  const far = Math.hypot(Math.max(-px, 0, px - T), Math.max(-T - pz, 0, pz)) > CAR_MID;
  const stamp = parked.stamp;
  if (far && c.far && c.stamp === stamp) return false;
  let same = c.lv !== undefined;
  const lv = c.lv ||= new Uint8Array(all.length);
  for (const { k } of all) {
    let l = 3;
    if (!far) { const d = Math.hypot(data[k] - px, data[k + 2] - pz); l = d < CAR_NEAR ? 1 : d < CAR_MID ? 2 : 3; }
    if (parked.isGone(tile, k)) l = 0;
    if (lv[k / 6] !== l) { lv[k / 6] = l; same = false; }
  }
  c.far = far; c.stamp = stamp;
  if (same) return false;
  let nb = 0;
  for (const g of groups) {
    let nh = 0, nl = 0;
    for (const { k } of g.list) {
      const l = lv[k / 6];
      if (l === 1) fill(g.hi, nh++, data, k);
      else if (l === 2) fill(g.lo, nl++, data, k);
      else if (l === 3) fill(box, nb++, data, k);
    }
    finish(g.hi, nh); finish(g.lo, nl);
  }
  finish(box, nb);
  return true;
}
const tmpO = new THREE.Object3D();
const solids = createSolids();   // cars, trees, lamps, furniture and other players (see solids.js)
let driving = null;              // set up once the player exists (see 'driving' below)
function instances(tile, name, data) {
  // cars wait for their models; by then the square may have gone again (the player moved on)
  if (name === 'car') { carsReady.then(() => { if (tiles.get(squareKey(tile.i, tile.j)) === tile) carInstances(tile, data); }); return; }
  solids.add(tile, footprintsOf(name, data, tile.group.position));
  if (name === 'tree') tile.trees = data;   // kept for the background sounds (more trees, more birds)
  shapeInstances(tile, name, data);
}
function shapeInstances(tile, name, data) {
  const doorMeshes = name === 'door' ? [] : null;
  const shape = SHAPES[name]; if (!shape) return;
  const n = data.length / 6;
  for (const [geo, mat, role] of shape) {
    const m = new THREE.InstancedMesh(geo, mat, n);
    for (let k = 0; k < n; k++) {
      const o = k * 6;
      tmpO.position.set(data[o], data[o + 1], data[o + 2]); tmpO.rotation.set(0, data[o + 3], 0); tmpO.scale.setScalar(data[o + 4]); tmpO.updateMatrix();
      m.setMatrixAt(k, tmpO.matrix);
      if (role === 'paint') m.setColorAt(k, PAINT.setHex(data[o + 5]));
      else if (role === 'leaf') m.setColorAt(k, PAINT.setHex(LEAF[(Math.abs(Math.round(data[o] * 7 + data[o + 2] * 13))) % LEAF.length]));
    }
    m.computeBoundingSphere();
    m.castShadow = role !== 'pool'; m.receiveShadow = true;
    if (role === 'pool') { m.renderOrder = 2; m.visible = nightK > 0.02; pools.add(m); }
    tile.group.add(m); doorMeshes?.push(m);
  }
  if (doorMeshes) homes.adopt(tile, data, doorMeshes[0]);   // real doors replace the flat ones near you (home.js)
}
const pools = new Set();

// ---------- labels ----------
function label(text, bg = '#fff8e6') {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  ctx.font = 'bold 40px system-ui, sans-serif';
  const w = Math.min(ctx.measureText(text).width + 40, 900); c.width = w; c.height = 72;
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, w, 72, 18); ctx.fill();
  ctx.fillStyle = '#2b2b2b'; ctx.font = 'bold 40px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText(text, 20, 38, w - 40);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, fog: false }));
  sp.userData.base = w / 72 * 2.2; sp.visible = false;
  return sp;
}
const signs = new Set();

// ---------- squares: state and streaming ----------
const tiles = new Map();          // key -> { i, j, level, group, coll, meta, textures, sprites }
const wanted = new Map();         // key -> desired level
const inflight = new Map();       // key -> level being loaded
const ready = [];                 // decoded results waiting to be applied
const failed = new Map();         // key -> { until, wait }: a square whose download failed waits (2 s, doubling to 60 s) before another try
let tilesRev = 0;                 // bumped whenever a square comes or goes (blockedAt keeps the square it last looked in)
const workers = [0, 1].map(() => new Worker(new URL('./loader.worker.js', import.meta.url)));
let reqId = 0; const pending = new Map();
if (params.get('net')) workers.forEach(w => w.postMessage({ net: params.get('net').split(',').map(Number) }));
// persistent file cache per region bake; older bakes of this region are dropped. Off on this computer's
// dev server (squares get rebaked one by one there) unless ?cache=1.
const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
if (info.build && (LOCAL ? params.get('cache') === '1' : params.get('cache') !== '0') && self.caches) {
  const name = `toycity-${slug}-${info.build}`;
  workers.forEach(w => w.postMessage({ cacheName: name }));
  caches.keys().then(ks => ks.filter(k => k.startsWith(`toycity-${slug}-`) && k !== name).forEach(k => caches.delete(k)));
}
workers.forEach(w => w.onmessage = ({ data }) => { const p = pending.get(data.id); pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data); });
function load(files, images, onId) {
  const id = ++reqId, w = workers[id % workers.length];
  if (onId) onId(id, w);
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ id, files, images }); });
}
const url = f => new URL(f, base).href;

function cancelSquare(key) {
  const r = inflight.get(key); inflight.delete(key);
  if (r?.id) r.worker.postMessage({ cancel: r.id });
}
function requestSquare(key, level) {
  const r = { level }; inflight.set(key, r);
  const files = level === 'near' ? { b: url(`t/${key}.b.bin`), d: url(`t/${key}.d.bin`) } : { f: url(`t/${key}.f.bin`) };
  const images = { a: url(level === 'near' ? `a/${key}.jpg` : `a/${key}_s.jpg`) };
  load(files, images, (id, worker) => Object.assign(r, { id, worker }))
    .then(res => { if (inflight.get(key) === r) ready.push({ key, level, r: res, req: r }); else for (const b of Object.values(res.images)) b.close(); })
    .catch(e => {
      if (inflight.get(key) !== r) return;
      inflight.delete(key);
      if (/cancel/.test(e.message)) return;
      console.warn(key, e);
      const wait = Math.min((failed.get(key)?.wait || 1000) * 2, 60000); failed.set(key, { until: performance.now() + wait, wait });
    });
}

function disposeTile(t) {
  if (!t) return;
  parked.drop(t); solids.drop(t); birds.drop(t); homes.release(t); driving?.release?.(t);
  // the ground plane and the sprites' geometry are shared by every square: those stay
  t.group.traverse(o => { if (o.isMesh && !o.isInstancedMesh && !o.userData.ground) o.geometry.dispose(); if (o.isInstancedMesh) { o.dispose(); pools.delete(o); } });
  for (const tx of t.textures) tx.dispose();
  for (const m of t.materials) m.dispose();
  for (const s of t.sprites) { s.material.map.dispose(); s.material.dispose(); signs.delete(s); }
  scene.remove(t.group);
  shadowDirty = true;
}

const GROUND_GEO = new THREE.PlaneGeometry(T, T).rotateX(-Math.PI / 2).translate(T / 2, 0, -T / 2);   // one for every square
function applySquare({ key, level, r, req }) {
  if (inflight.get(key) !== req) { for (const b of Object.values(r.images)) b.close(); return; } // cancelled
  inflight.delete(key);
  // a far square that arrives after the square became wanted near still fills in, unless near is there
  if (!wanted.has(key) || (level === 'far' && tiles.get(key)?.level === 'near')) { for (const b of Object.values(r.images)) b.close(); return; }
  const [i, j] = key.split('_').map(Number);
  const tile = { i, j, level, group: new THREE.Group(), textures: [], materials: [], sprites: [], coll: null, meta: null };
  tile.group.position.set(i * T - ORX, 0, -(j * T - ORY));
  const near = level === 'near';
  const aerial = aerialTexture(r.images.a, near ? 8 : 2); tile.textures.push(aerial);
  // aerial photo as ground (fills anything the BGT surfaces do not cover) and on every roof
  const groundMat = new THREE.MeshLambertMaterial({ map: aerial }); tile.materials.push(groundMat);
  const ground = new THREE.Mesh(GROUND_GEO, groundMat); ground.position.y = near ? 0.02 : 0;
  ground.receiveShadow = near; ground.userData.ground = true; tile.group.add(ground);
  const roofMat = std({ map: aerial, roughness: 0.8 }); tile.materials.push(roofMat);
  const q = quantGroup(); tile.group.add(q);
  const add = (file, name, mat, shadow) => {
    const g = file.header.groups[name]; if (!g) return;
    const mesh = new THREE.Mesh(qGeo(file, g), mat);
    mesh.castShadow = shadow && !NO_SHADOW_CAST.has(name); mesh.receiveShadow = shadow;
    if (name.startsWith('wall') || name === 'roof') mesh.userData.solid = true;
    if (name === 'water') tile.water = mesh.geometry;
    if (name.startsWith('surf:')) (tile.surf ||= []).push(mesh.geometry);
    q.add(mesh);
  };
  if (near) {
    const { b, d } = r.files;
    for (const name of Object.keys(b.header.groups)) add(b, name, name === 'roof' ? roofMat : M[name], true);
    for (const name of Object.keys(d.header.groups)) if (M[name]) add(d, name, M[name], true);
    for (const [name, [off, len]] of Object.entries(d.header.inst)) instances(tile, name, new Float32Array(d.buf, d.base + off, len));
    tile.coll = new Uint8Array(d.buf, d.base + d.header.coll[0], d.header.coll[1]);
    tile.low = d.header.low ? new Uint8Array(d.buf, d.base + d.header.low[0], d.header.low[1]) : null;
    tile.meta = d.header.meta;
    if (tile.water) {   // the ponds in world metres (x, z) for the birds; the geometry is quantised
      const P = tile.water.attributes.position.array, n = P.length / 3, xz = new Float32Array(n * 2); let ys = 0;
      const gx = tile.group.position.x, gz = tile.group.position.z;
      for (let k = 0; k < n; k++) { xz[2 * k] = P[3 * k] * QQ.q - QQ.ox + gx; xz[2 * k + 1] = P[3 * k + 2] * QQ.q - QQ.oz + gz; ys += P[3 * k + 1] * QQ.q - QQ.oy; }
      birdsLater.push(() => {
        if (tiles.get(key) !== tile) return;
        tile.waterY = ys / n; tile.wet = wetMask(tile, xz, tile.water.index.array);
        birds.add(tile, xz, tile.water.index.array, ys / n + 0.03, key);
      });
    }
    if (tile.surf) birdsLater.push(() => { if (tiles.get(key) === tile) tile.ground = groundMap(tile); });
    for (const [n, k, x, y] of d.header.meta.pois.slice(0, 80)) {
      const sp = label(n, /church|place_of_worship|townhall|school/.test(k) ? '#e6ecff' : '#fff8e6');
      sp.position.set(x, 9.5, -y); tile.group.add(sp); tile.sprites.push(sp); signs.add(sp);
    }
  } else {
    const { f } = r.files;
    add(f, 'wall', M.farwall, false); add(f, 'roof', roofMat, false);
  }
  disposeTile(tiles.get(key));
  tiles.set(key, tile); tilesRev++; failed.delete(key);
  scene.add(tile.group);
  maskOverviews();
}

function rectDist(i, j, X, Y) {
  const dx = Math.max(i * T - X, 0, X - (i + 1) * T), dy = Math.max(j * T - Y, 0, Y - (j + 1) * T);
  return Math.hypot(dx, dy);
}
// ---------- overview: the coarse 2 km level (tools/overview.mjs) ----------
// Merged building blocks with flat roofs coloured by a 2 m aerial mosaic. Always shown out to the
// horizon; the part of an overview that a loaded 500 m square covers is hidden in the vertex shader
// (one bit per square), so there is never an empty patch while a square is still downloading.
const OV = info.overview || null;
const ovTiles = new Map();       // key -> { mesh, ground, uniforms } or 'loading'
const OV_GROUND = OV && new THREE.PlaneGeometry(OV.size, OV.size).rotateX(-Math.PI / 2).translate(OV.size / 2, 0, OV.size / 2);   // one for every overview
const ovWall = new THREE.Color(0xb9a48f);
function ovMaterial(tex) {
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const uniforms = { uHide: { value: 0 }, uWall: { value: ovWall } };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float sq;\nuniform int uHide;\nvarying float vWall;')
      .replace('#include <uv_vertex>', `vMapUv = vec2(position.x - ${(OV.margin / OV.q).toFixed(1)}, ${((OV.size + OV.margin) / OV.q).toFixed(1)} - position.z) / ${(OV.size / OV.q).toFixed(1)};`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = 1.0 - abs(normal.y);\nif (((uHide >> int(sq + 0.5)) & 1) == 1) transformed = vec3(0.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWall;\nvarying float vWall;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb * 0.85, uWall, step(0.5, vWall));');
  };
  return { mat, uniforms };
}
function updateOverview(X, Y) {
  if (!OV) return;
  const S = OV.size;
  for (const [oi, oj] of OV.tiles) {
    const key = squareKey(oi, oj), d = Math.hypot(Math.max(oi * S - X, 0, X - (oi + 1) * S), Math.max(oj * S - Y, 0, Y - (oj + 1) * S));
    const have = ovTiles.get(key);
    if (d > Q.horizon + 500) { if (have && have !== 'loading') { scene.remove(have.group); have.mesh.geometry.dispose(); have.mat.dispose(); have.groundMat.dispose(); have.tex.dispose(); ovTiles.delete(key); } continue; }
    if (have) continue;
    ovTiles.set(key, 'loading');
    load({ o: url(`o/${key}.bin`) }, { a: url(`o/${key}.jpg`) }).then(({ files: { o }, images: { a } }) => {
      if (ovTiles.get(key) !== 'loading') { a.close(); return; }
      const h = o.header, buf = o.buf, base = o.base, geo = new THREE.BufferGeometry();
      const group = new THREE.Group(); group.position.set(oi * S - ORX, 0, -((oj + 1) * S - ORY));
      const tex = aerialTexture(a, 4), { mat, uniforms } = ovMaterial(tex);
      const groundMat = new THREE.MeshLambertMaterial({ map: tex });
      const ground = new THREE.Mesh(OV_GROUND, groundMat); ground.position.y = -0.4;
      group.add(ground);
      let mesh = null;
      if (h.count) {
        const I = h.index[2] === 'Uint32Array' ? Uint32Array : Uint16Array;
        geo.setIndex(new THREE.BufferAttribute(new I(buf, base + h.index[0], h.index[1]), 1));
        geo.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(buf, base + h.pos[0], h.pos[1]), 3));
        const nb = new THREE.InterleavedBuffer(new Int8Array(buf, base + h.nrm[0], h.nrm[1]), 4);
        geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(nb, 3, 0, true));
        geo.setAttribute('sq', new THREE.InterleavedBufferAttribute(nb, 1, 3, false));
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3((S / 2 + OV.margin) / OV.q, 0, (S / 2 + OV.margin) / OV.q), S / OV.q);
        mesh = new THREE.Mesh(geo, mat); mesh.scale.setScalar(OV.q); mesh.position.set(-OV.margin, 0, -OV.margin); group.add(mesh);
      }
      const t = { group, mesh: mesh || { geometry: geo }, mat, groundMat, tex, uniforms, oi, oj };
      ovTiles.set(key, t); scene.add(group); maskOverview(t);
    }).catch(e => { console.warn('overview', key, e); ovTiles.delete(key); });
  }
}
// hide the blocks of every square that has its own geometry loaded
function maskOverview(t) {
  let m = 0;
  for (let b = 0; b < OV.n; b++) for (let a = 0; a < OV.n; a++) if (tiles.has(squareKey(t.oi * OV.n + a, t.oj * OV.n + b))) m |= 1 << (a + b * OV.n);
  t.uniforms.uHide.value = m;
}
function maskOverviews() { for (const t of ovTiles.values()) if (t !== 'loading') maskOverview(t); }

// ---------- choosing squares: look ahead along the direction of travel ----------
// A square is wanted at the level its distance to the stretch of road the player covers in the next
// few seconds asks for, so at speed the squares ahead are fetched first. A square already loaded keeps
// its level until it is clearly out of range (hysteresis), so driving along a boundary does not make
// it load and unload again. Requests that are no longer wanted are cancelled.
const AHEAD_S = 4, KEEP = 80;
const vel = { x: 0, y: 0, X: null, Y: null, t: 0 };
function updateWanted() {
  const [X, Y] = toRD(player.position.x, player.position.z), now = performance.now();
  if (vel.X !== null) {
    const dt = Math.max((now - vel.t) / 1000, 1e-3), k = Math.min(1, dt * 2);
    vel.x += ((X - vel.X) / dt - vel.x) * k; vel.y += ((Y - vel.Y) / dt - vel.y) * k;
  }
  vel.X = X; vel.Y = Y; vel.t = now;
  const speed = Math.hypot(vel.x, vel.y), AX = X + vel.x * AHEAD_S, AY = Y + vel.y * AHEAD_S;
  // camera looks along fwd (RD east, north)
  camera.getWorldDirection(tmpV); const fl = Math.hypot(tmpV.x, tmpV.z) || 1, fx = tmpV.x / fl, fy = -tmpV.z / fl;
  const R = Math.ceil((Q.far + KEEP * 2 + speed * AHEAD_S) / T) + 1, ci = Math.floor(X / T), cj = Math.floor(Y / T);
  const next = new Map(), score = new Map();
  for (let i = ci - R; i <= ci + R; i++) for (let j = cj - R; j <= cj + R; j++) {
    const key = squareKey(i, j); if (!HAVE.has(key)) continue;
    const d = rectDist(i, j, X, Y);
    // distance to the path ahead (sampled in 25 m steps), and how soon the player gets near it:
    // metres still to travel plus the distance from there
    let dp = d, soon = d;
    for (let s = 1, n = Math.ceil(speed * AHEAD_S / 25); s <= n; s++) {
      const e = rectDist(i, j, X + (AX - X) * s / n, Y + (AY - Y) * s / n);
      dp = Math.min(dp, e); soon = Math.min(soon, e + speed * AHEAD_S * s / n);
    }
    const cur = tiles.get(key)?.level;
    let lv = dp < Q.near ? 'near' : dp < Q.far ? 'far' : null;
    if (cur === 'near' && d < Q.near + KEEP) lv = 'near';
    else if (cur && !lv && d < Q.far + KEEP * 2) lv = cur === 'near' ? 'far' : cur;
    if (!lv) continue;
    next.set(key, lv);
    // what to fetch first: nearest along the path, squares in view before those behind the camera,
    // and an empty square (only the overview showing) before an upgrade of one that already has blocks
    const cx = (i + 0.5) * T - X, cy = (j + 0.5) * T - Y, behind = d > T && (cx * fx + cy * fy) < 0;
    score.set(key, soon + (behind ? 400 : 0) + (cur ? 250 : 0) - (lv === 'near' && d < 60 ? 1000 : 0));
  }
  wanted.clear(); for (const [k, v] of next) wanted.set(k, v);
  let changed = false;
  for (const [k, t] of tiles) if (!wanted.has(k)) { disposeTile(t); tiles.delete(k); changed = true; }
  if (changed) { maskOverviews(); tilesRev++; }
  for (const [k] of inflight) if (!wanted.has(k)) cancelSquare(k);
  const todo = [...wanted].filter(([k, lv]) => tiles.get(k)?.level !== lv && !inflight.has(k) && !(failed.get(k)?.until > now)).sort((a, b) => score.get(a[0]) - score.get(b[0]));
  for (const [k, lv] of todo) { if (inflight.size >= 4) break; requestSquare(k, lv); }
  updateOverview(X, Y);
}
const tmpV = new THREE.Vector3();

// ---------- player and camera ----------
const player = new THREE.Group();
{
  const bodyM = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.8, 4, 10), std({ color: 0x2f6fde })); bodyM.position.y = 0.75 + 0.15;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), std({ color: 0xe0b896 })); head.position.y = 1.62 + 0.15;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.3, 12), std({ color: 0xe24a3b })); cap.position.y = 1.95 + 0.15;
  for (const m of [bodyM, head, cap]) { m.castShadow = true; player.add(m); }
}
// rigged person (models/person.glb, dressed in Blender by tools/dress_person.py) with idle / walk / run
// blended by actual speed, and one pose clip (models/anims.glb: jumping, riding, falling, knocking...)
// layered over them (avatar.pose, see avatar.js poseLayer); the capsule above stays until it has loaded
const avatar = { mixer: null, actions: null, pose: null, speed: 0 };
// the player's own look: a random person and outfit given on the first visit, kept on this device
async function useAvatar(look) {
  const { model, clips } = await loadAvatar(new URL('./', import.meta.url), { look });
  if (avatar.mixer) { avatar.mixer.stopAllAction(); avatar.mixer.uncacheRoot(avatar.model); }
  // the old body's own materials (its outfit, see avatar.js dress); its geometry and textures belong to the cached model
  avatar.model?.traverse(o => { if (o.isMesh && o.userData.own) o.material.dispose(); });
  for (const c of [...player.children]) if (!c.userData.keep) player.remove(c);   // keep the ears (voice.js)
  player.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const actions = { idle: mixer.clipAction(clips.idle), walk: mixer.clipAction(clips.walk), run: mixer.clipAction(clips.run) };
  for (const a of Object.values(actions)) { a.play(); a.setEffectiveWeight(0); }
  actions.idle.setEffectiveWeight(1);
  Object.assign(avatar, { mixer, actions, pose: poseLayer(mixer, clips), model });
}
useAvatar(myLook()).catch(e => console.warn('avatar', e));
// natural speeds of the clips in m/s at this scale, used to keep the feet from sliding
const WALK_MS = 1.5, RUN_MS = 4.2;
function animateAvatar(dt, moved) {
  if (!avatar.mixer) return;
  const sp = moved / Math.max(dt, 1e-4);
  avatar.speed += (sp - avatar.speed) * Math.min(1, dt * 8);
  const s = avatar.speed, a = avatar.actions;
  const w = THREE.MathUtils.clamp(s / WALK_MS, 0, 1), r = THREE.MathUtils.clamp((s - 2.2) / 1.8, 0, 1);
  pickPose();
  const k = avatar.pose.update(dt);   // what the pose clip leaves for walking
  a.idle.setEffectiveWeight((1 - w) * k);
  a.walk.setEffectiveWeight(w * (1 - r) * k);
  a.run.setEffectiveWeight(w * r * k);
  a.walk.timeScale = THREE.MathUtils.clamp(s / WALK_MS, 0.6, 1.6);
  a.run.timeScale = THREE.MathUtils.clamp(s / RUN_MS, 0.8, 2.2);
  avatar.mixer.update(dt);
  ridePlace();
}
// the pose clip for this moment (motion capture, see avatar.js); being hit (knockDown, flingStep) and
// knocking at a door (homes) start their own. Jumping: jump_start begins crouched and pushes off in
// its first tenth of a second, then holds the legs up; jump_loop takes over if the air lasts longer
// (stepping off a hedge); jump_land absorbs the landing and stands up again in 0.8 s.
function pickPose() {
  const P = avatar.pose;
  if (driving.rider) return P.set('drive');
  if (you.seated) return P.set(null);   // inside a car: not seen
  if (fling.on || homes.busy) return;
  if (sat) {   // sitting down (sit_enter, once), sitting (on a call: sit_talk), getting up (sit_exit)
    if (seatMove && !seatMove.down) return P.set('sit_exit', { once: true, fade: 0.15 });
    if ((P.name === 'sit_enter' && P.done) || P.name === 'sit_idle' || P.name === 'sit_talk') return P.set(social?.inCall ? 'sit_talk' : 'sit_idle', { fade: 0.3 });
    if (P.name !== 'sit_enter') P.set('sit_enter', { once: true, fade: 0.2 });
    return;
  }
  if (swim.on) return P.set(avatar.speed > 0.25 ? 'swim' : 'swim_idle', { fade: 0.3 });
  if (jump.phase === 'crouch') return P.set('jump_start', { once: true });
  if (jump.phase === 'air') { if (P.name !== 'jump_start' || P.done) P.set('jump_loop'); return; }
  if (jump.phase === 'land') return P.set('jump_land', { once: true });
  const landing = P.name === 'jump_land' && P.time < 0.8, knocking = P.name === 'knock' && !P.done;
  if ((landing || knocking) && avatar.speed < 0.5) return;
  P.set(social?.inCall && avatar.speed < 0.3 ? 'talk' : null);   // on a call, standing still: hands talk along
}
// on a motorbike the person turns to face the bike's front and sits down on the saddle (the drive clip
// has the hips 0.61 m over the feet; the saddle is 0.92 m over the ground)
function ridePlace() {
  const m = avatar.model; if (!m) return;
  const riding = driving?.rider, f = FRONT.bike ?? 1;
  m.rotation.y = riding ? f * Math.PI / 2 : 0;
  const so = sat && !riding ? sitOffset(sat.h) : null;
  m.position.set(riding ? -0.12 * f : 0, riding ? 0.31 : so ? so.y * seatK : 0, so ? so.z * seatK : 0);
}
player.position.set(info.start ? info.start.x - ORX : 0, 0.15, info.start ? -(info.start.y - ORY) : 0);
scene.add(player);

let fly = false, yaw = Math.PI, pitch = 0.5, dist = 14;
let firstPerson = false;   // set from the saved choice once the page is up (see setFirstPerson)
const orbit = new OrbitControls(camera, renderer.domElement); orbit.enabled = false; orbit.enableDamping = true; orbit.maxDistance = 2500; orbit.maxPolarAngle = Math.PI / 2 - 0.02;
let dragging = false, lx = 0, ly = 0, downAt = null;
// look around by dragging with one pointer (mouse or one finger); two fingers on the view pinch-zoom.
// Only the pointer that started the drag turns the camera, so a thumb on the joystick does not.
const touches = new Map();
let dragId = null, pinch = 0;
renderer.domElement.addEventListener('pointerdown', e => {
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); dragging = false; downAt = null; return; }
  downAt = [e.clientX, e.clientY]; if (!fly) { dragging = true; dragId = e.pointerId; lx = e.clientX; ly = e.clientY; }
});
addEventListener('pointerup', e => { touches.delete(e.pointerId); if (e.pointerId === dragId) { dragging = false; dragId = null; } });
addEventListener('pointercancel', e => { touches.delete(e.pointerId); if (e.pointerId === dragId) { dragging = false; dragId = null; } });
addEventListener('pointermove', e => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (touches.size === 2 && pinch) { const [a, b] = [...touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > 10) { zoomBy(pinch / d); pinch = d; } return; }
  if (!dragging || fly || e.pointerId !== dragId) return;
  const k = e.pointerType === 'touch' ? 1.6 : 1;
  yaw -= (e.clientX - lx) * 0.005 * k; pitch = THREE.MathUtils.clamp(pitch + (e.clientY - ly) * 0.004 * k, 0.12, 1.35); lx = e.clientX; ly = e.clientY;
});

// ---------- touch controls (phones and tablets) ----------
// A joystick bottom left walks (push it all the way to run), a button bottom right jumps.
const joy = { x: 0, y: 0, id: null };
if (matchMedia('(pointer: coarse)').matches || params.get('touch')) {
  document.body.classList.add('touch');
  const pad = document.getElementById('joy'), knob = pad.querySelector('div'), R = 46;
  const move = e => {
    const r = pad.getBoundingClientRect(); let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const l = Math.hypot(dx, dy); if (l > R) { dx *= R / l; dy *= R / l; }
    joy.x = dx / R; joy.y = dy / R; knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const end = e => { if (e.pointerId !== joy.id) return; joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
  pad.addEventListener('pointerdown', e => { e.preventDefault(); joy.id = e.pointerId; try { pad.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ } move(e); });
  pad.addEventListener('pointermove', e => { if (e.pointerId === joy.id) move(e); });
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  document.getElementById('jumpbtn').addEventListener('pointerdown', e => { e.preventDefault(); if (you.can('jump')) walker.startJump(); });
}
function zoomBy(f) {
  if (fly) { const off = camera.position.clone().sub(orbit.target).multiplyScalar(f); if (off.length() > 8 && off.length() < 2500) camera.position.copy(orbit.target).add(off); }
  else dist = THREE.MathUtils.clamp(dist * f, 4, 600);
}
renderer.domElement.addEventListener('wheel', e => { e.preventDefault(); if (!fly) zoomBy(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))); }, { passive: false });
document.getElementById('zin').onclick = () => { if (firstPerson) setFirstPerson(false); zoomBy(1 / 1.6); };
const eyesBtn = document.getElementById('eyesbtn'); if (eyesBtn) eyesBtn.onclick = () => setFirstPerson(!firstPerson);
document.getElementById('zout').onclick = () => zoomBy(1.6);
// ---------- driving (web/vehicle.js): E or the 🚗 button gets you into the nearest parked car ----------
// short messages (a ticket, a crash) appear where the start hint was, then fade again
function note(text) {
  const h = document.getElementById('hint'); if (!h) return;
  h.textContent = text; h.classList.remove('gone'); clearTimeout(note.t); note.t = setTimeout(() => h.classList.add('gone'), 4500);
}
// ---------- front doors and homes (home.js) ----------
// the inside of every house (interior.js): you walk about in it while you are in a house
const room = createInterior({ scene, loader: new GLTFLoader(), createSolids });
const homes = createHomes({ scene, player, tiles, T, toRD, fromRD, slug, note, loader: new GLTFLoader(),
  room: { enter: d => room.load().then(() => { const p = room.enter(d); dist = 3.0; pitch = 0.2; return p; }), leave: () => { room.leave(); dist = 8; } },
  look: y => { yaw = y; pitch = Math.min(pitch, 0.35); dist = room.active ? 3.2 : Math.max(6, Math.min(dist, 12)); },
  onKnock: () => avatar.pose?.set('knock', { once: true }) });
driving = createDriving({ scene, player, models: CAR_MODELS, parked, solids, ground: (x, z) => blockedAt(x, z), note, onHitPerson: hitPerson, onBumpCar: (x, z) => traffic?.bumped(x, z) });

// ---------- knocking people over, and the card you get for it ----------
// Drive into someone and they go flying (their own game plays it: see knockDown). The driver gets a card
// over their car or head that everyone sees: yellow the first time, red if it happens again while the
// yellow is still showing. It wears off after a few minutes of driving nicely.
const CARD_FOR = 180;                    // seconds a card stays up after the last offence
const card = { level: 0, t: 0, sprite: null };
function cardSprite(level) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 88;
  const x = c.getContext('2d'); x.fillStyle = level > 1 ? '#e02424' : '#ffd21f';
  x.beginPath(); x.roundRect(6, 4, 52, 80, 8); x.fill(); x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 3; x.stroke();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(0.42, 0.58, 1); sp.renderOrder = 21; sp.userData.card = level;
  return sp;
}
function showCard(group, level, y) {
  const old = group.children.find(o => o.userData.card !== undefined);
  if (old && old.userData.card === level) { old.position.y = y; return; }
  if (old) { group.remove(old); old.material.map.dispose(); old.material.dispose(); }
  if (level) { const sp = cardSprite(level); sp.position.y = y; group.add(sp); }
}
function hitPerson(id, vx, vz) {
  const p = social?.presence.peers.get(id);
  if (!peds?.hit(id, vx, vz)) social?.presence.sendTo(id, { t: 'hit', vx, vz, by: social.presence.name });   // one of the town's people, or a player
  card.level = Math.min(2, card.level + 1); card.t = CARD_FOR;
  note(card.level > 1 ? `🟥 Red card! You hit ${p?.name || 'someone'} again. Everyone can see it.` : `🟨 Yellow card: you hit ${p?.name || 'someone'}. Drive carefully.`);
}
// someone drove into you: fly, land, lie there a moment, get up (only when on foot)
const fling = { on: false, vx: 0, vz: 0, vy: 0, h: 0, down: 0 };
// Health: 100, a hit takes 3 to 6 by its speed (so some twenty to thirty hits), and it comes back by
// 1 every 4 s. At 0 you are knocked out: flat on the ground, screen grey, 30 s before you get up again.
const HEALTH = 100, OUT_FOR = 30;
const health = { hp: HEALTH, out: 0, hitT: 0 };
const hpBar = document.getElementById('hp');
function showHealth() {
  if (!hpBar) return;
  hpBar.hidden = health.hp >= HEALTH && !health.out;
  hpBar.firstElementChild.style.width = health.hp + '%';
  hpBar.classList.toggle('low', health.hp < 30);
  hpBar.lastElementChild.textContent = health.out ? `Knocked out · back in ${Math.ceil(health.out)} s` : `❤️ ${Math.round(health.hp)}`;
  document.body.classList.toggle('ko', health.out > 0);
}
function knockDown({ vx, vz, by }) {
  if (!you.can('hit')) return;   // in a car, or flying
  const who = typeof by === 'string' && by ? by.slice(0, 40) : 'Someone';
  if (!health.out && performance.now() - health.hitT > 400) {   // one hit counts once, even if the car lingers
    health.hitT = performance.now();
    health.hp = Math.max(0, health.hp - Math.min(6, 3 + Math.hypot(vx, vz) * 0.25));
    if (!health.hp) { health.out = OUT_FOR; note(`💫 ${who} knocked you out. You'll be back in ${OUT_FOR} seconds.`); }
    showHealth();
  }
  if (fling.on) return;
  const sp = Math.min(14, Math.hypot(vx, vz) || 3), k = sp / (Math.hypot(vx, vz) || 1);
  Object.assign(fling, { on: true, vx: vx * k * 0.7, vz: vz * k * 0.7, vy: 3 + sp * 0.35, h: 0, down: 0 });
  you.halt();
  avatar.pose?.set('hit', { once: true });
  const f = document.getElementById('ouch'); if (f) { f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }
  if (!health.out) note(`🤕 Ouch! ${who} ran you over. Health ${Math.round(health.hp)}/${HEALTH}.`);
}
// one frame of flying or lying down; returns true while it runs (no walking meanwhile).
// The clips: the hit's flinch, then the fall (its body collapses backwards over 0.93 s and lies flat
// from 1.4 s; landing jumps to the moment it hits the ground, FALL_DOWN), and sit_exit to get up again.
function flingStep(dt) {
  if (!fling.on) return false;
  const P = avatar.pose;
  if (fling.down === 0) {
    const nx = player.position.x + fling.vx * dt, nz = player.position.z + fling.vz * dt;
    if (!blocked(nx, nz)) { player.position.x = nx; player.position.z = nz; } else { fling.vx *= -0.3; fling.vz *= -0.3; }
    fling.vy -= 9.8 * dt; fling.h += fling.vy * dt;
    if (P && P.name === 'hit' && P.done) P.set('fall', { once: true });
    if (fling.h <= 0) {
      fling.h = 0; fling.down = 0.001;
      if (P) { if (P.name !== 'fall') P.set('fall', { once: true, from: FALL_DOWN }); else if (P.time < FALL_DOWN) P.time = FALL_DOWN; }
    }
  } else {
    fling.down += dt;
    if (health.out) return true;   // knocked out: stay down until the time is up
    // flat on the back for 2.5 s, then up again
    if (fling.down > 2.5 && P && P.name === 'fall') P.set('sit_exit', { once: true, fade: 0.3 });
    if (fling.down > 3.4) { fling.on = false; P?.set(null, { fade: 0.2 }); needUnstick = true; }
  }
  return true;
}
let walkDist = dist;
// ---------- riding along: get into a friend's car as a passenger ----------
// E next to someone who is driving puts you in their passenger seat; you move with their car until E again.
// Others see you as "ride:0" (hidden, you are inside the car). The driver's own game does the driving.
let ride = null;   // the peer whose car you are in
function driverNear() {
  const peers = social?.presence?.peers; if (!peers) return null;
  let best = null, bd = 4;
  for (const p of peers.values()) {
    if (!p.car || isPassenger(p.car) || !p.player) continue;
    const g = p.player.group.position, d = Math.hypot(g.x - player.position.x, g.z - player.position.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
// the passenger seat: beside the driver (front right), or behind the rider on a motorbike
const tmpS = new THREE.Vector3();
function seat(p, out) { const g = p.player.group; return seatAt(carModel(p.car), g.position.x, g.position.z, g.rotation.y, out); }
function seatAt(name, x, z, h, out) {
  const [along, across] = PASSENGER[name] || PASSENGER.suv, [lx, lz] = seatLocal(name, along, -across);   // left of the driver
  return out.set(x + lx * Math.cos(h) + lz * Math.sin(h), 0.15, z - lx * Math.sin(h) + lz * Math.cos(h));
}
function toggleCar() {
  if (health.out) return;   // knocked out
  if (fly) toggleFly();
  if (ride) {
    const pk = ride.parked?.sx !== undefined && !ride.car ? ride.parked : null;
    if (pk) {   // out of the parked car through your own door: beside the passenger seat, clear of the car
      const s = seatAt(pk.model, pk.sx, pk.sz, pk.h, tmpS), dx = s.x - pk.sx, dz = s.z - pk.sz, d = Math.hypot(dx, dz) || 1, out = 1.4;
      player.position.x = s.x + dx / d * out; player.position.z = s.z + dz / d * out;
      if (blockedAt(player.position.x, player.position.z)) { player.position.x = pk.sx - dx / d * (d + out); player.position.z = pk.sz - dz / d * (d + out); }
    } else {
      const g = ride.player?.group, h = g ? g.rotation.y : 0;
      if (g) { player.position.x = g.position.x + Math.sin(h) * 2.2; player.position.z = g.position.z + Math.cos(h) * 2.2; }
    }
    note('👋 Thanks for the ride, ' + (ride.name || 'friend') + '!'); ride = null; dist = walkDist; needUnstick = true;
    carBtn(true); return;
  }
  if (!driving.driving) {
    // a friend driving within reach wins over any parked car: they are waiting for you
    const d = driverNear();
    if (d) {
      you.halt();
      ride = d; walkDist = dist; dist = Math.max(dist, 10); note('🚗 Riding along with ' + (d.name || 'a friend') + '. E to get out.');
      carBtn(true); return;
    }
  }
  if (driving.driving) {
    stopAuto();
    const spot = driving.exit();
    player.position.x = spot.x; player.position.z = spot.z; dist = walkDist; needUnstick = false;
  } else {
    const car = driving.nearest(player.position); if (!car) return;
    you.halt();
    driving.enter(car); walkDist = dist; dist = Math.max(dist, 10); pitch = firstPerson ? 0.5 : Math.min(pitch, 0.35);
  }
  for (const t of parked.tiles) updateCars(t);
  shadowDirty = true; carBtn(true); apBtn();
}
const carButton = document.getElementById('carbtn');
const btnAt = { x: NaN, z: NaN, mode: '' };   // where, and in what, the player was at the last look at the parked cars
function carBtn(force) {
  if (!carButton) return;
  const p = player.position, friend = you.onFoot && driverNear();
  const mode = you.mode + (friend ? '+friend' : '');
  if (!force && mode === btnAt.mode && Math.hypot(p.x - btnAt.x, p.z - btnAt.z) < 0.5) return;
  btnAt.x = p.x; btnAt.z = p.z; btnAt.mode = mode;
  const near = you.onFoot && driving.nearest(p);
  const hidden = !you.seated && !near && !friend;
  const text = you.seated ? '🚶 Get out (E)' : friend ? '🙋 Ride along (E)' : '🚗 Get in (E)';
  if (carButton.hidden !== hidden) carButton.hidden = hidden;
  if (carButton.textContent !== text) carButton.textContent = text;
}
carButton?.addEventListener('click', e => { e.stopPropagation(); toggleCar(); });

// ---------- autopilot: in a car or on the bike, name a place (or click the map) and lean back ----------
// The route follows the region's OpenStreetMap streets (autopilot.js); W/A/S/D, the joystick or getting
// out takes the wheel back.
const autopilot = createAutopilot({
  // ?v: the segments carry direction, vehicle and speed flags now; a cached older file would not parse
  roadsUrl: new URL('roads.json?v=2', base).href, fromRD,
  fromWGS: (la, lo) => { const [X, Y] = wgsToRd(la, lo); return [X - ORX, ORY - Y]; },
  toWGS: (x, z) => rdToWgs(...toRD(x, z)),
  inside: (x, z) => HAVE.has(grid.keyAt(x, z)),
});
// ---------- ambient life: cars on the streets and people on the pavements (traffic.js, peds.js) ----------
// The same for everyone: fixed loops on the road graph, timed by the wall clock (see ambient.js).
// ?traffic=0 or the 🚗 Traffic button turns it off; the counts follow the quality preset.
const qName = params.get('quality') || 'mid';
let trafficOn = params.get('traffic') !== '0' && localStorage.getItem('toycity.traffic') !== 'off';
// the players everyone knows about besides me (other people in the square), so that a car waiting for
// someone waits in every browser alike; the list is reused, filled once per frame at most
const othersList = [];
function others() {
  othersList.length = 0;
  const peers = social?.presence?.peers; if (!peers) return othersList;
  for (const q of peers.values()) {
    const g = q.player?.group; if (!g || !g.visible || (q.car && isPassenger(q.car))) continue;
    othersList.push({ x: g.position.x, z: g.position.z, inCar: !!q.car });
  }
  return othersList;
}
// ---------- birds on the water (birds.js): which ones come from Sovon's survey numbers, see facts.html ----------
const birds = createBirds({ scene, THREE, loadModel: u => new GLTFLoader().loadAsync(u) });
const birdsLater = [];   // finding the ponds takes a moment: one square's worth per frame, after it is drawn
const ambientOpts = { scene, autopilot, solids, slug, T, toRD, others, ground: (x, z) => groundAt(x, z) };
const traffic = createTraffic({ ...ambientOpts, models: CAR_MODELS, sounds: () => social?.ambience?.on ?? true, count: trafficOn ? TRAFFIC_N[qName] || TRAFFIC_N.mid : 0 });
const peds = createPeds({ ...ambientOpts, count: trafficOn ? PEDS_N[qName] || PEDS_N.mid : 0 });
const me = { x: 0, z: 0, onFoot: true, inCar: false, fly: false };   // what the ambient life needs to know of me
const trafficBtn = document.getElementById('trafficbtn');
function setTraffic(on) {
  trafficOn = on; localStorage.setItem('toycity.traffic', on ? 'on' : 'off');
  traffic.setCount(on ? TRAFFIC_N[qName] || TRAFFIC_N.mid : 0); peds.setCount(on ? PEDS_N[qName] || PEDS_N.mid : 0);
  if (trafficBtn) { trafficBtn.textContent = on ? '🚗 Traffic' : '🚗 Traffic off'; trafficBtn.setAttribute('aria-pressed', on); }
}
trafficBtn?.addEventListener('click', () => setTraffic(!trafficOn));
setTraffic(trafficOn);
// ---------- car radio (radio.js) ----------
const radio = createRadio();
const radioBox = mountRadio(document.body, radio);
// ---------- finding someone: a route line to another player (nav.js) ----------
const nav = createNav({ scene, player, driving, autopilot, walksUrl: new URL('walks.json', base), fromRD, heading: () => yaw, note });
mountNav(document.getElementById('nav'), nav);
const apButton = document.getElementById('apbtn'), apForm = document.getElementById('apform'), apInput = document.getElementById('apq');
async function autoTo(x, z, label) {
  note('🧭 Planning a route to ' + label + '…');
  const [fx, fz] = driving.forward;
  const vehicle = driving.model === 'bike' ? 'bike' : 'car';
  const r = await autopilot.start({ x: player.position.x, z: player.position.z, fx, fz }, { x, z }, label, vehicle).catch(e => { console.warn('autopilot', e); return null; });
  if (!r) { note('🧭 No road there from here, sorry.'); return; }
  note(`🧭 Autopilot to ${label}: ${(r.length / 1000).toFixed(1)} km${r.source === 'local' ? ' (offline route)' : ''}. Steer to take over.`);
  apBtn();
}
// the status line while on autopilot: the next turn if it is close, else what is left of the trip
function apLine() {
  const n = autopilot.next, km = (autopilot.remaining / 1000).toFixed(1);
  if (n && n.in < 250) return `${n.text} in ${Math.round(n.in / 10) * 10} m  ·  `;
  return `🧭 ${km} km to ${autopilot.label}  ·  `;
}
function stopAuto(why) { if (!autopilot.active) return; autopilot.stop(); if (why) note(why); apBtn(); }
function apBtn() {
  if (!apButton) return;
  apButton.hidden = !driving.driving;
  apButton.textContent = autopilot.active ? '✋ Stop autopilot' : '🧭 Autopilot';
  if (!driving.driving) apForm.hidden = true;
}
apButton?.addEventListener('click', e => {
  e.stopPropagation();
  if (autopilot.active) return stopAuto('🧭 Autopilot off. Your wheel.');
  apForm.hidden = !apForm.hidden; if (!apForm.hidden) { apInput.value = ''; apInput.focus(); }
});
apForm?.addEventListener('submit', async e => {
  e.preventDefault(); const q = apInput.value.trim(); if (!q) return;
  apInput.blur(); apForm.hidden = true;
  const hit = await findPlace(q);
  if (!hit) return note('🧭 Could not find "' + q + '" here.');
  autoTo(hit[0] - ORX, -(hit[1] - ORY), hit[2]);
});
apInput?.addEventListener('keydown', e => { if (e.key === 'Escape') { apForm.hidden = true; apInput.blur(); } });
const keys = {};
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.key.toLowerCase()] = true;
  if (e.key.toLowerCase() === 'e' && !e.repeat && you.can('car')) toggleCar();
  else if (e.key.toLowerCase() === 'e' && !e.repeat && homes.inside) { if (sat) standUp(); else sitDown(); }
  if (e.key.toLowerCase() === 'g' && !e.repeat && !swim.on) startSwim();
  if (e.key.toLowerCase() === 'f') { if (driving.driving) toggleCar(); toggleFly(); }
  if (e.key.toLowerCase() === 'v') setFirstPerson(!firstPerson);
  if (e.key.toLowerCase() === 'm') toggleMap();
  if (radio.inCar && !e.repeat && e.key.toLowerCase() === 'r') radio.next();
  if (radio.inCar && (e.key === '[' || e.key === ']')) { e.key === '[' ? radio.quieter() : radio.louder(); radioBox.flashVolume(); }
  if (e.key === '-' || e.key === '_') zoomBy(1.6); if (e.key === '=' || e.key === '+') zoomBy(1 / 1.6);
  if (e.key.startsWith('Arrow')) e.preventDefault();
  if (e.key === ' ') { e.preventDefault(); if (you.can('jump')) walker.startJump(); }
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
function toggleFly() { fly = !fly; orbit.enabled = fly; if (fly) orbit.target.copy(player.position); }

// click (not drag) to walk somewhere; in fly mode, drop in at the spot
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let goal = null;
function stopWalk() { goal = detour = null; sitGoal = faceGoal = null; marker.visible = false; }   // the click-to-go goal (and any way round it) is dropped
// ?agent=1: an AI agent plays (tools/mcp). It moves only through what a person can do, at a person's speed:
// walking or running to a point, the car and its autopilot, doors. It cannot jump to a place once in.
const AGENT = params.get('agent') === '1' ? { run: false, draw: 0 } : null;
let voiceCap = AGENT ? params.get('voice') === '1' : localStorage.getItem('toycity.calls') !== 'off';
const marker = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.2, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthTest: false }));
marker.visible = false; marker.renderOrder = 10; scene.add(marker);
// Click (or tap) where to go. In a house there is more to click than the floor: a seat walks you to it
// and sits you down, a person walks you up to them, the front door takes you outside, and a click on a
// wall or a table goes to the nearest spot beside it. The way round the furniture is found from the
// start (localPath), so you never walk into a sofa and stop.
let sitGoal = null, faceGoal = null;   // sit down there on arrival; turn to this person on arrival
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  downAt = null;
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const targets = [], folk = [];
  if (room.active) {   // in a house: anything in it, and the people in it
    targets.push(room.group);
    for (const q of social?.presence?.peers?.values() || []) if (q.inMyHouse && q.player?.group.visible) { targets.push(q.player.group); folk.push(q); }
  } else for (const t of tiles.values()) t.group.traverse(o => { if (o.userData.ground || o.userData.solid) targets.push(o); });
  const hit = ray.intersectObjects(targets, room.active)[0];
  let pt, who = null, seat = null;
  if (hit) {
    pt = hit.point.clone();
    if (hit.object.userData.solid && hit.face) { const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld); n.y = 0; pt.add(n.lengthSq() > 0.01 ? n.normalize().multiplyScalar(2.5) : new THREE.Vector3(camera.position.x - pt.x, 0, camera.position.z - pt.z).normalize().multiplyScalar(3)); }
    if (room.active) {
      if (/^(doorpaint|handle)$/.test(hit.object.material?.name) && !homes.busy) { stopWalk(); homes.comeOut(); return; }   // the front door: out you go
      who = folk.find(q => { let o = hit.object; while (o) { if (o === q.player.group) return true; o = o.parent; } return false; });
    }
  } else { const y0 = room.active ? room.floorY : 0, t = (y0 - ray.ray.origin.y) / ray.ray.direction.y; if (!(t > 0)) return; pt = ray.ray.at(t, new THREE.Vector3()); }
  pt.y = 0.15;
  if (driving.driving) return;
  if (room.active) {
    room.clamp(pt);
    const p = player.position;
    if (who) {   // up to them: a metre away, on the side you come from
      const g = who.player.group.position, d = Math.hypot(g.x - p.x, g.z - p.z);
      if (d < 1.3) { stopWalk(); faceGoal = who; faceStep(); return; }   // already there: just turn to them
      pt.set(g.x + (p.x - g.x) / d, 0.15, g.z + (p.z - g.z) / d);
    } else if ((seat = room.seatNear(pt.x, pt.z, 0.7, takenSeats()))) {   // a seat: go and sit on it
      if (sat === seat) return;
      const [x, z] = room.standSpot(seat, (x, z) => !blocked(x, z)); pt.set(x, 0.15, z);
    }
    // a click on a table or a sofa lands on the floor under it: the nearest free spot beside it
    if (blocked(pt.x, pt.z)) {
      let best = null, bd = Infinity;
      for (let r = 0.25; r <= 1.5 && !best; r += 0.25) for (let a = 0; a < 16; a++) {
        const x = pt.x + Math.sin(a * Math.PI / 8) * r, z = pt.z + Math.cos(a * Math.PI / 8) * r;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < bd && !blocked(x, z)) { bd = d; best = [x, z]; }
      }
      if (!best) return;
      pt.x = best[0]; pt.z = best[1];
    }
  }
  if (fly) { toggleFly(); yaw = Math.atan2(camera.position.x - pt.x, camera.position.z - pt.z); player.position.copy(pt); stopWalk(); return; }
  stopWalk();
  goal = pt; sitGoal = seat; faceGoal = who;
  marker.position.set(seat ? seat.x : pt.x, (room.active ? room.floorY : 0) + (seat ? seat.h + 0.1 : 0.35), seat ? seat.z : pt.z); marker.visible = true;
  // in a house, a way round the sofas and tables from the start (the grid is fine and the room small)
  detour = null; detourQ = []; detours = 0;
  if (room.active && !lineClear(player.position.x, player.position.z, pt.x, pt.z)) sidestep();
});
// arrived: sit down on the seat that was clicked, or turn to the person
function arrive() {
  const s = sitGoal, q = faceGoal; stopWalk();
  if (s) sitDown(s); else if (q) { faceGoal = q; faceStep(); }
}
function faceStep() {
  const q = faceGoal; if (!q || !q.player || !q.inMyHouse) { faceGoal = null; return; }
  const g = q.player.group.position, p = player.position, target = Math.atan2(g.x - p.x, g.z - p.z);
  let d = target - player.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
  player.rotation.y += d * 0.15; if (Math.abs(d) < 0.03) faceGoal = null;
}

// collision against the pre-built 0.5 m bitmaps of loaded near squares (grid.js has the layout)
// coll always blocks (walls, water, fences, tree trunks, lamp posts); low (hedges) only feet below h = 0.5 m
const bAt = { i: NaN, j: NaN, rev: -1, t: null };   // the square blockedAt last looked in (most tests stay in one)
function blockedAt(x, z, h = 0) {
  if (room.active) return room.blockedAt(x, z);   // in a house: its walls are the map
  const X = x + ORX, Y = ORY - z, i = Math.floor(X / T), j = Math.floor(Y / T);
  if (i !== bAt.i || j !== bAt.j || bAt.rev !== tilesRev) { bAt.i = i; bAt.j = j; bAt.rev = tilesRev; bAt.t = tiles.get(squareKey(i, j)) || null; }
  const t = bAt.t;
  if (!t || !t.coll) return false;
  const bit = grid.cellBit(X, Y, i, j);
  return getBit(t.coll, bit) === 1 || (h < 0.5 && !!t.low && getBit(t.low, bit) === 1);
}
// ---------- water you can swim in: a 0.5 m bitmap per near square, like coll, from its water triangles ----------
function wetMask(tile, xz, idx) {
  const bits = newBitmap(), ox = tile.i * T, oy = tile.j * T, set = c => setBit(bits, c);
  // each triangle in the square's own RD metres (X east, Y north from its corner)
  const X = k => xz[2 * k] + ORX - ox, Y = k => ORY - xz[2 * k + 1] - oy;
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2]; eachCell(X(a), Y(a), X(b), Y(b), X(c), Y(c), set); }
  return bits;
}
// ---------- the height of the ground: the pavement stands 12 cm above the road, gardens and grass a few cm ----------
// From the square's own surface shapes (road, pavement, paths, grass, raised beds), the top of the
// highest one in each 0.5 m cell, in cm above the road. Feet stand on it (walker.js, peds.js); others'
// feet follow from the height they send.
const ROAD = 0.15;   // the road's top, the level everything else is measured from (buildtiles.mjs TOP.road)
function groundMap(tile) {
  const cm = new Uint8Array(SIDE * SIDE), gx = tile.group.position.x, gz = tile.group.position.z, ox = tile.i * T, oy = tile.j * T;
  for (const g of tile.surf) {
    const P = g.attributes.position.array, idx = g.index.array;
    const X = k => P[3 * k] * QQ.q - QQ.ox + gx + ORX - ox, Y = k => ORY - (P[3 * k + 2] * QQ.q - QQ.oz + gz) - oy, H = k => P[3 * k + 1] * QQ.q - QQ.oy;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2], h = Math.round((Math.max(H(a), H(b), H(c)) - ROAD) * 100);
      if (h <= 0) continue;   // road level, or a slab's underside
      const v = Math.min(255, h);
      eachCell(X(a), Y(a), X(b), Y(b), X(c), Y(c), cell => { if (cm[cell] < v) cm[cell] = v; });
    }
  }
  return cm;
}
// metres above the road at x, z (0 on the road, or where the map is not loaded yet)
function groundAt(x, z) {
  if (room.active) return 0;   // the house's floor
  const X = x + ORX, Y = ORY - z, i = Math.floor(X / T), j = Math.floor(Y / T), t = tiles.get(squareKey(i, j));
  return t && t.ground ? t.ground[grid.cellBit(X, Y, i, j)] / 100 : 0;
}
function wetAt(x, z) {   // the water level there, or null on dry land
  if (room.active) return null;
  const X = x + ORX, Y = ORY - z, i = Math.floor(X / T), j = Math.floor(Y / T), t = tiles.get(squareKey(i, j));
  if (!t || !t.wet) return null;
  return getBit(t.wet, grid.cellBit(X, Y, i, j)) ? t.waterY : null;
}
// Swimming: near the water a Swim button (or G) takes you in; you swim (W/A/S/D, click, Shift faster)
// anywhere the water goes, and climb out by swimming onto the bank. Others see it too (pose 6).
const swim = { on: false, y: 0 };
const SWIM_MS = 1.1, SWIM_FAST = 2;
function waterNear(r = 2.5) {   // the nearest swimmable spot within r metres, 0.6 m in from the edge
  const p = player.position;
  for (let d = 0.5; d <= r; d += 0.5) for (let a = 0; a < 16; a++) {
    const cx = Math.cos(a * Math.PI / 8), cz = Math.sin(a * Math.PI / 8), x = p.x + cx * d, z = p.z + cz * d;
    if (wetAt(x, z) !== null && wetAt(x + cx * 0.6, z + cz * 0.6) !== null) return [x + cx * 0.6, z + cz * 0.6];
  }
  return null;
}
function startSwim() {
  if (!you.can('swim')) return;
  const w = waterNear(); if (!w) return;
  player.position.x = w[0]; player.position.z = w[1]; you.halt();
  swim.on = true; swim.y = wetAt(w[0], w[1]) ?? 0;
  note('🏊 Swimming. Swim onto the bank to climb out.'); swimBtn(true);
}
function stopSwim(say = true) { if (!swim.on) return; swim.on = false; if (say) note('💧 Out of the water.'); swimBtn(true); }
const swimButton = document.getElementById('swimbtn');
const swimAt = { x: NaN, z: NaN, on: null };
// ---------- sitting down in a house: a chair at the table or the sofa (seats in interior.json) ----------
// E or the Sit button near a seat; any move (a key, the joystick, a click) stands you up again.
let sat = null;
const SIT_REACH = 1.4;
const takenSeats = () => [...(social?.presence?.peers?.values() || [])].filter(p => p.player?.sitting).map(p => [p.player.group.position.x, p.player.group.position.z]);
// Indoors only the house is drawn: the camera switches to the INDOORS layer, which the room, the
// lights, you and the people in the same house are on (re-marked twice a second: bodies change).
let indoorOn = false, indoorT = 0;
for (const l of [sun, hemi, amb]) l.layers.enable(INDOORS);
const onIndoors = o => o.traverse(c => c.layers.enable(INDOORS));
// Another player's car standing where one of this square's parked cars is (they took it and stopped, or
// parked it back, or left it there): only one car can be in that spot, so the parked one steps aside here,
// as it did for them. Taken this way only on this screen, and given back when they drive off.
const hiddenUnder = new Set(); let hideT = 0;
function hideUnderOthers() {
  if ((hideT -= 1 / 60) > 0) return; hideT = 0.5;
  const peers = social?.presence?.peers, want = new Set();
  if (peers) for (const p of peers.values()) {
    const spots = [];
    if (p.parked?.sx !== undefined) spots.push([p.parked.sx, p.parked.sz]);
    if (p.car && !isPassenger(p.car) && p.player && Math.abs(p.speed || 0) < 0.5) spots.push([p.player.group.position.x, p.player.group.position.z]);
    for (const [x, z] of spots) for (const t of parked.tiles) {   // taken ones too: one already hidden must stay hidden
      const d = t.cars.data, ox = t.group.position.x, oz = t.group.position.z;
      for (let k = 0; k < d.length; k += STRIDE) if (Math.hypot(d[k] + ox - x, d[k + 2] + oz - z) < 1.8) want.add(parked.key(t, k));
    }
  }
  for (const k of hiddenUnder) if (!want.has(k)) { hiddenUnder.delete(k); parked.setTaken(k, false); }
  for (const k of want) if (!hiddenUnder.has(k) && !parked.isTaken(k)) { hiddenUnder.add(k); parked.setTaken(k, true); }
}
function indoorView() {
  const on = room.active;
  if (on !== indoorOn) {
    indoorOn = on; camera.layers.set(on ? INDOORS : 0); indoorT = 0; roomLight(on);
    // a blink, not a cut; going in, it stays dark until the room's light is ready (the first time the
    // materials are rebuilt for the lamp, about a second), so no half-drawn frame shows
    fadeEl.style.opacity = 1;
    const ready = on && renderer.compileAsync ? renderer.compileAsync(scene, camera).catch(() => {}) : Promise.resolve();
    ready.then(() => { fadeEl.style.opacity = 0; fadeEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, easing: 'ease-out' }); });
  }
  if (!on || (indoorT -= 1 / 60) > 0) return;
  indoorT = 0.5;
  onIndoors(player); onIndoors(marker);
  for (const p of social?.presence?.peers?.values() || []) if (p.inMyHouse && p.player) onIndoors(p.player.group);
}
// Indoors the street's sun and sky would light the room as if it had no roof. While you are in, they
// become the room's light: daylight from the back window (the sun, turned to come through it), a warm
// bounce off the walls (hemi), little sky reflection on glossy things, and the lamp over the tea table,
// brighter at night. The town's values come back when you leave.
const lamp = new THREE.PointLight(0xffc890, 0, 6, 2); lamp.layers.set(INDOORS); scene.add(lamp);
let outdoor = null;
function roomLight(on) {
  if (on) {
    outdoor ||= { sun: sun.color.getHex(), si: sun.intensity, sky: hemi.color.getHex(), gnd: hemi.groundColor.getHex(), hi: hemi.intensity, ai: amb.intensity, env: scene.environmentIntensity, exp: renderer.toneMappingExposure };
    sun.color.setHex(0xfff3e4); sun.intensity = 1.3 * (1 - 0.85 * nightK);
    hemi.color.setHex(0xfff2e0); hemi.groundColor.setHex(0x705c48); hemi.intensity = 1.25 - 0.6 * nightK;
    amb.intensity = 0.08; scene.environmentIntensity = 0.15; renderer.toneMappingExposure = 1.0;
    if (room.lights[0]) lamp.position.set(...room.lights[0]);
    lamp.intensity = 4 + 6 * nightK; room.daylight(1 - nightK);
  } else if (outdoor) {
    sun.color.setHex(outdoor.sun); sun.intensity = outdoor.si; hemi.color.setHex(outdoor.sky); hemi.groundColor.setHex(outdoor.gnd);
    hemi.intensity = outdoor.hi; amb.intensity = outdoor.ai; scene.environmentIntensity = outdoor.env; renderer.toneMappingExposure = outdoor.exp;
    lamp.intensity = 0; outdoor = null;
  }
}
const fadeEl = Object.assign(document.createElement('div'), { id: 'fade' });
Object.assign(fadeEl.style, { position: 'fixed', inset: 0, background: '#000', opacity: 0, pointerEvents: 'none', zIndex: 40 });
document.body.append(fadeEl);
player.add(blobMesh(0.75));   // a soft shadow under you indoors (only the indoor camera draws it)
// sitting down and getting up are moves, not cuts: the body turns and steps onto the seat while sit_enter
// bends it down (hips drop between 0.4 and 1 s), or rises with sit_exit and steps off. seatK: how far it
// is lowered onto the seat (0 standing .. 1 seated), for ridePlace
let seatMove = null, seatK = 0;
function sitDown(s = room.seatNear(player.position.x, player.position.z, SIT_REACH, takenSeats())) {
  if (!s || !homes.inside || homes.busy || Math.hypot(s.x - player.position.x, s.z - player.position.z) > SIT_REACH) return false;   // only a seat within reach
  stopWalk(); jump.h = 0; jump.phase = null;
  sat = s; seatMove = { down: true, t: 0, glide: 0.4, l0: 0.35, l1: 1.0, from: [player.position.x, player.position.z, player.rotation.y], to: [s.x, s.z, s.yaw] };
  yaw = s.yaw + Math.PI + 0.45; sitBtn(true); return true;   // over your shoulder, a three-quarter view
}
function standUp() {
  if (!sat || seatMove) return;
  const [x, z] = room.standSpot(sat, (x, z) => !blocked(x, z));
  seatMove = { down: false, t: 0, glide: 0.8, l0: 0.1, l1: 0.7, from: [player.position.x, player.position.z, sat.yaw], to: [x, z, sat.yaw] };
  sitBtn(true);   // sat stays until you are up: the seat holds you, walking waits
}
function seatStep(dt) {
  const m = seatMove; if (!m) return;
  m.t += dt;
  const ease = x => x * x * (3 - 2 * x), g = ease(Math.min(1, m.t / m.glide)), l = ease(THREE.MathUtils.clamp((m.t - m.l0) / (m.l1 - m.l0), 0, 1));
  player.position.x = m.from[0] + (m.to[0] - m.from[0]) * g; player.position.z = m.from[1] + (m.to[1] - m.from[1]) * g;
  const da = Math.atan2(Math.sin(m.to[2] - m.from[2]), Math.cos(m.to[2] - m.from[2])); player.rotation.y = m.from[2] + da * g;
  seatK = m.down ? l : 1 - l;
  if (m.t >= m.l1 + 0.1) { seatMove = null; if (!m.down) { sat = null; seatK = 0; sitBtn(true); } }
}
const sitButton = Object.assign(document.createElement('button'), { id: 'sitbtn', hidden: true });
document.body.append(sitButton);
sitButton.addEventListener('click', e => { e.stopPropagation(); sat ? standUp() : sitDown(); });
let sitAt = '';
function sitBtn(force) {
  const s = sat ? null : homes.inside && !homes.busy && avatar.speed < 0.3 ? room.seatNear(player.position.x, player.position.z, SIT_REACH, takenSeats()) : null;   // not while walking past
  const key = seatMove ? '' : sat ? 'up' : s ? 'sit' : '';
  if (!force && key === sitAt) return; sitAt = key;
  sitButton.hidden = !key; sitButton.textContent = sat ? '🧍 Stand up (E)' : '🪑 Sit down (E)';
}
function swimBtn(force) {
  if (!swimButton) return;
  const p = player.position;
  if (!force && swimAt.on === swim.on && Math.hypot(p.x - swimAt.x, p.z - swimAt.z) < 0.5) return;
  swimAt.x = p.x; swimAt.z = p.z; swimAt.on = swim.on;
  const hidden = !you.can('swim') || !waterNear();
  if (swimButton.hidden !== hidden) swimButton.hidden = hidden;
}
swimButton?.addEventListener('click', e => { e.stopPropagation(); startSwim(); });
// walking, bumping, jumping and finding a way round, over blockedAt (walker.js); while swimming, water is
// open, dry land you may step onto ends the swim, walls stay walls
// what you bump into and stand on: the town's things outside, the furniture in a house
const walkSolids = { topAt: (x, z, r) => (room.active ? room.solids : solids).topAt(x, z, r), hitAbove: (x, z, r, y) => (room.active ? room.solids : solids).hitAbove(x, z, r, y) };
const walker = createWalker({ blockedAt, wetAt, ground: groundAt, solids: walkSolids,
  step: () => room.active ? STEP_IN : STEP, radius: () => room.active ? BODY : PERSON.r, ceiling: () => room.active ? room.ceiling : Infinity, swimming: () => swim.on, flying: () => fly, standing: () => you.onFoot && !swim.on && !fling.on && !homes.busy && !sat });   // seated: the chair holds you
const { blocked, lineClear, localPath, jump } = walker;
// what the player is doing, asked in one place (player.js): may I jump, swim, get in, walk, be hit?
const you = createPlayerMode({ get driving() { return driving; }, get ride() { return ride; }, get fly() { return fly; }, swim, fling, jump, homes, health }, { stopWalk });
let movedThisFrame = 0;
const SLIDE = [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4];   // radians off the way you push, nearest first
let stuck = 0, needUnstick = true;
// An agent walks round what is in its way, as a person does: when the straight line to its goal is
// blocked, a way is found over the 0.5 m collision grid (A*, within about 50 m) and pulled straight
// where the view is clear; the points are walked one by one (detour). A few tries per goal, then it gives up.
let detour = null, detourQ = [], detours = 0;
function sidestep() {   // a way round, from here: false when there is none (or too many were needed)
  if (++detours > 3) return false;
  const p = player.position, path = localPath(p.x, p.z, goal.x, goal.z);
  if (!path) return false;
  detourQ = path; detour = new THREE.Vector3(...[detourQ[0][0], 0.15, detourQ[0][1]]); detourQ = detourQ.slice(1);
  return true;
}
// an address point sits inside its building: once that square is loaded, stand on the address's
// own street at the closest point, facing the house; otherwise step to the nearest open spot
let arriveStreet = info.start ? info.start.label.split(',')[0].replace(/\s+\d+\s*\w?$/, '') : null;
function unstick() {
  const p = player.position;
  const [X, Y] = toRD(p.x, p.z), t = tiles.get(grid.keyAtRD(X, Y));
  if (!t || !t.coll) return false;
  if (arriveStreet) {
    let best = 1e18, bx = 0, by = 0;
    for (const tt of tiles.values()) {
      if (!tt.meta) continue;
      const ox = tt.i * T, oy = tt.j * T;
      for (const [n, pts] of tt.meta.streets) {
        if (n !== arriveStreet) continue;
        for (let k = 0; k + 1 < pts.length; k++) {
          const ax = pts[k][0] + ox, ay = pts[k][1] + oy, dx = pts[k + 1][0] - pts[k][0], dy = pts[k + 1][1] - pts[k][1];
          const u = Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / (dx * dx + dy * dy || 1)));
          const qx = ax + dx * u, qy = ay + dy * u, d = (qx - X) ** 2 + (qy - Y) ** 2;
          if (d < best) { best = d; bx = qx; by = qy; }
        }
      }
    }
    arriveStreet = null;
    if (best < 80 * 80) {
      const nx = bx - ORX, nz = -(by - ORY);
      yaw = Math.atan2(nx - p.x, nz - p.z); p.x = nx; p.z = nz;   // camera sits on the street side, looking at the house
      if (!blocked(p.x, p.z)) return true;
    }
  }
  if (!blocked(p.x, p.z)) return true;
  for (let r = 1; r < 60; r += 0.5) for (let a = 0; a < 32; a++) {
    const x = p.x + Math.cos(a / 32 * Math.PI * 2) * r, z = p.z + Math.sin(a / 32 * Math.PI * 2) * r;
    if (!blocked(x, z)) { yaw = Math.atan2(x - p.x, z - p.z); p.x = x; p.z = z; return true; }
  }
  return true;
}

// Arrive near a spot (a meeting link, or Go next to someone): a few metres from it in a random
// direction, looking at it, so people who come to the same place stand around it, not on each other.
// If that spot is inside something solid, unstick() moves to the nearest free one once it has loaded.
function arriveNear(X, Y, r = 2 + Math.random() * 2) {
  const a = Math.random() * Math.PI * 2, cx = X - ORX, cz = -(Y - ORY);
  if (fly) toggleFly();
  stopWalk(); arriveStreet = null;
  player.position.set(cx + Math.cos(a) * r, 0.15, cz + Math.sin(a) * r);
  yaw = Math.atan2(player.position.x - cx, player.position.z - cz);   // camera behind me, the spot ahead
  dist = Math.min(dist, 20); needUnstick = true; updateWanted();
}
// ?meet=X,Y (RD metres): the place a meeting link points at
{ const m = (params.get('meet') || '').split(',').map(Number); if (m.length === 2 && m.every(Number.isFinite)) arriveNear(m[0], m[1]); }

// ---------- place names: nearest address within 25 m, else street ----------
function nearestPlace() {
  const [X, Y] = toRD(player.position.x, player.position.z);
  let best = 625, addr = null, sbest = 1e9, street = null, pbest = 3600, poi = null;
  for (const t of tiles.values()) {
    if (!t.meta) continue;
    const ox = t.i * T, oy = t.j * T;
    for (const [s, n, x, y] of t.meta.addr) { const d = (x + ox - X) ** 2 + (y + oy - Y) ** 2; if (d < best) { best = d; addr = s + ' ' + n; } }
    for (const [n, pts] of t.meta.streets) for (const [x, y] of pts) { const d = (x + ox - X) ** 2 + (y + oy - Y) ** 2; if (d < sbest) { sbest = d; street = n; } }
    for (const [n, , x, y] of t.meta.pois) { const d = (x + ox - X) ** 2 + (y + oy - Y) ** 2; if (d < pbest) { pbest = d; poi = n; } }
  }
  return (addr || street || info.title) + (poi ? '  ·  near ' + poi : '');
}

// ---------- search: lazy-loaded index of every address, place and street ----------
let searchIndex = null;
// an address, a place or a street -> [X, Y (RD metres), name, street], or null. First the region's own index
// (every BAG address, OpenStreetMap place and street); failing that, OpenStreetMap's Nominatim search
// inside the region, which knows landmarks, shops and alternative spellings.
async function findPlace(q) {
  searchIndex ||= await (await fetch(new URL('search.json', base))).json();
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const nq = norm(q), m = nq.match(/^(.*?)[ ,]+(\d+\s*[a-z]?)$/);
  if (!nq) return null;
  if (m) { const a = searchIndex.addr.find(([s, n]) => norm(s) === norm(m[1]) && norm(n).replace(/\s/g, '') === m[2].replace(/\s/g, '')); if (a) return [a[2], a[3], a[0] + ' ' + a[1], a[0]]; }
  // a chain has many shops of one name: take the nearest
  const [PX, PY] = toRD(player.position.x, player.position.z), near = l => l.sort((a, b) => Math.hypot(a[1] - PX, a[2] - PY) - Math.hypot(b[1] - PX, b[2] - PY))[0];
  const p = near(searchIndex.pois.filter(([n]) => norm(n) === nq)) || near(searchIndex.pois.filter(([n]) => norm(n).includes(nq))); if (p) return [p[1], p[2], p[0]];
  const s = Object.entries(searchIndex.streets).find(([n]) => norm(n) === nq) || Object.entries(searchIndex.streets).find(([n]) => norm(n).includes(nq)); if (s) return [s[1][0], s[1][1], s[0]];
  try {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [i, j] of info.squares) { x0 = Math.min(x0, i * T); y0 = Math.min(y0, j * T); x1 = Math.max(x1, (i + 1) * T); y1 = Math.max(y1, (j + 1) * T); }
    const [la0, lo0] = rdToWgs(x0, y0), [la1, lo1] = rdToWgs(x1, y1);
    const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1&countrycodes=nl'
      + `&viewbox=${lo0},${la1},${lo1},${la0}&q=` + encodeURIComponent(q);
    for (const r of await (await fetch(u, { headers: { Accept: 'application/json' } })).json()) {
      const [X, Y] = wgsToRd(+r.lat, +r.lon);
      if (HAVE.has(grid.keyAtRD(X, Y))) return [X, Y, r.name || r.display_name.split(',')[0]];
    }
  } catch { /* offline or rate-limited: not found */ }
  return null;
}
async function goTo(q) {
  const hit = await findPlace(q);
  if (!hit) { place.textContent = 'not found: ' + q; return; }
  if (hit[3]) arriveStreet = hit[3];
  if (driving.driving) return autoTo(hit[0] - ORX, -(hit[1] - ORY), hit[2]);   // in a car: drive there
  if (fly) toggleFly();
  stopWalk();
  player.position.set(hit[0] - ORX, 0.15, -(hit[1] - ORY));
  dist = Math.min(dist, 20);
  needUnstick = true;
  updateWanted();
}
document.getElementById('goto').addEventListener('submit', e => { e.preventDefault(); goTo(document.getElementById('q').value); document.getElementById('q').blur(); });

// ---------- time of day ----------
let nightK = 0;
const TOD = {
  morning: { el: 14, az: 100, sun: 0xffe2c0, si: 1.4, hemi: 1.1, amb: 0.3, env: 0.4, exp: 0.8, fog: 0xc7d6e2, night: 0 },
  noon: { el: 50, az: 200, sun: 0xfff2d8, si: 1.6, hemi: 1.4, amb: 0.35, env: 0.45, exp: 0.85, fog: 0x9ccbe8, night: 0 },
  golden: { el: 7, az: 255, sun: 0xffb46a, si: 1.5, hemi: 0.8, amb: 0.22, env: 0.3, exp: 0.85, fog: 0xe8c6a0, night: 0.15 },
  dusk: { el: -2, az: 280, sun: 0xff8a5a, si: 0.35, hemi: 0.45, amb: 0.15, env: 0.15, exp: 0.9, fog: 0x5a5f7a, night: 0.75 },
  night: { el: -12, az: 300, sun: 0x8aa0ff, si: 0.18, hemi: 0.25, amb: 0.12, env: 0.06, exp: 1.0, fog: 0x10162a, night: 1 },
};
function applyTime(name) {
  const t = TOD[name] || TOD.noon, el = THREE.MathUtils.degToRad(Math.max(t.el, 4)), az = THREE.MathUtils.degToRad(t.az), tel = THREE.MathUtils.degToRad(t.el);
  SUN_OFFSET.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(480);
  sun.color.setHex(t.sun); sun.intensity = t.si; hemi.intensity = t.hemi; amb.intensity = t.amb;
  scene.environmentIntensity = t.env; renderer.toneMappingExposure = t.exp; scene.fog.color.setHex(t.fog);
  sky.material.uniforms.sunPosition.value.set(Math.sin(az) * Math.cos(tel), Math.sin(tel), Math.cos(az) * Math.cos(tel));
  if (t.el > -6) bakeSky(); else scene.background = new THREE.Color(0x0b1124);
  nightK = t.night;
  M.winlit.emissiveIntensity = 1.3 * nightK; M.lamphead.emissiveIntensity = 4 * nightK; M.pool.opacity = 0.75 * nightK;
  M.chargerLight.emissiveIntensity = 0.6 + 2 * nightK;
  for (const p of pools) p.visible = nightK > 0.02;
  traffic?.setNight(nightK);
  shadowDirty = true;
  if (indoorOn) { outdoor = null; roomLight(true); }   // inside when the time changes: the room's light, from the new town values
}
document.getElementById('tod').onchange = e => applyTime(e.target.value);
document.getElementById('quality').onchange = e => { const u = new URL(location.href); u.searchParams.set('quality', e.target.value); location.href = u.href; };
applyTime(params.get('time') || 'noon');
if (params.get('time')) document.getElementById('tod').value = params.get('time');

// ---------- OpenStreetMap minimap ----------
function rdToWgs(x, y) {
  const dx = (x - 155000) * 1e-5, dy = (y - 463000) * 1e-5;
  const n = 3235.65389 * dy - 32.58297 * dx ** 2 - 0.2475 * dy ** 2 - 0.84978 * dx ** 2 * dy - 0.0655 * dy ** 3 - 0.01709 * dx ** 2 * dy ** 2 - 0.00738 * dx + 0.0053 * dx ** 4 - 0.00039 * dx ** 2 * dy ** 3 + 0.00033 * dx ** 4 * dy - 0.00012 * dx * dy;
  const e = 5260.52916 * dx + 105.94684 * dx * dy + 2.45656 * dx * dy ** 2 - 0.81885 * dx ** 3 + 0.05594 * dx * dy ** 3 - 0.05607 * dx ** 3 * dy + 0.01199 * dy - 0.00256 * dx ** 3 * dy ** 2 + 0.00128 * dx * dy ** 4 + 0.00022 * dy ** 2 - 0.00022 * dx ** 2 + 0.00026 * dx ** 5;
  return [52.1551744 + n / 3600, 5.38720621 + e / 3600];
}
function wgsToRd(lat, lon) {
  const p = 0.36 * (lat - 52.1551744), l = 0.36 * (lon - 5.38720621);
  const x = 190094.945 * l - 11832.228 * p * l - 114.221 * p * p * l - 32.391 * l ** 3 - 0.705 * p - 2.34 * p ** 3 * l - 0.608 * p * l ** 3 - 0.008 * l * l + 0.148 * p * p * l ** 3;
  const y = 309056.544 * p + 3638.893 * l * l + 73.077 * p * p - 157.984 * p * l * l + 59.788 * p ** 3 + 0.433 * l - 6.439 * p * p * l * l - 0.032 * p * l + 0.092 * l ** 4 - 0.054 * p * l ** 4;
  return [155000 + x, 463000 + y];
}
// The map is off until asked for (🗺️ or M), so the game page stays quiet; the choice is remembered.
let mini = null, meMarker = null, followMini = true;
function initMap() {
  if (mini || !window.L) return;
  mini = L.map('mini', { zoomControl: false }).setView(rdToWgs(...toRD(player.position.x, player.position.z)), 17);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mini);
  mini.attributionControl.setPrefix(false);
  meMarker = L.marker(rdToWgs(...toRD(player.position.x, player.position.z)), { icon: L.divIcon({ className: '', html: '<div class="me-arrow"></div>', iconSize: [14, 18], iconAnchor: [7, 9] }) }).addTo(mini);
  mini.on('dragstart', () => { followMini = false; setTimeout(() => followMini = true, 6000); });
  mini.on('click', e => {
    const [X, Y] = wgsToRd(e.latlng.lat, e.latlng.lng);
    if (!HAVE.has(grid.keyAtRD(X, Y))) return;
    if (driving.driving) return autoTo(X - ORX, -(Y - ORY), 'the spot on the map');   // in a car: drive there
    if (fly) toggleFly();
    const far = Math.hypot(X - ORX - player.position.x, -(Y - ORY) - player.position.z) > 600;
    if (far) { player.position.set(X - ORX, 0.15, -(Y - ORY)); stopWalk(); updateWanted(); return; } // jump, then stream in
    goal = new THREE.Vector3(X - ORX, 0.15, -(Y - ORY)); marker.position.set(goal.x, 0.35, goal.z); marker.visible = true;
  });
  document.getElementById('minibtn').onclick = () => { document.getElementById('mini').classList.toggle('big'); setTimeout(() => mini.invalidateSize(), 250); };
  setInterval(() => {
    const ll = rdToWgs(...toRD(player.position.x, player.position.z));
    meMarker.setLatLng(ll);
    const el = meMarker.getElement(); if (el) el.firstChild.style.transform = `rotate(${(-yaw * 180 / Math.PI).toFixed(0)}deg)`;
    if (followMini) mini.panTo(ll, { animate: false });
  }, 150);
}
function toggleMap(on = document.getElementById('mini').hidden) {
  document.getElementById('mini').hidden = !on; document.getElementById('minibtn').hidden = !on;
  document.getElementById('mapbtn')?.setAttribute('aria-pressed', on);
  localStorage.setItem('toycity.map', on ? '1' : '0');
  if (on) { initMap(); mini?.invalidateSize(); }
}
document.getElementById('mapbtn')?.addEventListener('click', () => toggleMap());
if (localStorage.getItem('toycity.map') === '1') document.readyState === 'complete' ? toggleMap(true) : addEventListener('load', () => toggleMap(true));   // Leaflet loads deferred
// the menu (☰) holds everything that isn't needed while walking; a hint says so for a few seconds
{ const btn = document.getElementById('menubtn'), hud = document.getElementById('hud');
  btn?.addEventListener('click', () => { hud.hidden = !hud.hidden; btn.setAttribute('aria-expanded', !hud.hidden); });
  setTimeout(() => document.getElementById('hint')?.classList.add('gone'), 7000); }

// ---------- frame loop ----------
const place = document.getElementById('place'), perf = params.get('perf') ? document.getElementById('perf') : {};   // numbers only with ?perf=1
let last = performance.now(), placeT = 0, wantT = 0, signT = 0, frames = 0, fpsT = performance.now(), loaded = false, placeText = '';
// first-person view (V or the eye button): the camera sits at the eyes and looks where you face;
// dragging still turns and tilts the head, and your own body is hidden
function setFirstPerson(on) {
  firstPerson = on; localStorage.setItem('toycity.view', on ? 'eyes' : 'chase');
  if (on && you.seated) pitch = 0.5;   // look at the road, a touch below the horizon
  const b = document.getElementById('eyesbtn'); if (b) b.setAttribute('aria-pressed', on);
  dispatchEvent(new Event('toycity:view'));
}
// in the driver's seat the dashboard is half a metre away: a closer near plane and a wider lens there
// in a house: a closer near plane (furniture a metre away is not cut off) and a wider lens for a small room
function lens(seat, inside) {
  const near = seat ? 0.06 : inside ? 0.1 : 0.5, fov = seat ? 68 : inside ? 62 : 55;
  if (camera.near !== near || camera.fov !== fov) { camera.near = near; camera.fov = fov; camera.updateProjectionMatrix(); }
}
// the cracked windscreen over the driver's-seat view of a wrecked car
const crackEl = document.getElementById('cracks');
function cracks(on) { if (crackEl && crackEl.hidden === !!on) crackEl.hidden = !on; }
function chaseCam() {
  lens(firstPerson && you.seated, room.active);
  if (firstPerson) {
    const look = 0.42 - pitch;                     // drag up and down to look up and down
    if (ride) {
      cracks(false);
      camera.position.set(player.position.x, 1.22, player.position.z);
      for (const c of player.children) c.visible = false;
    } else if (driving.driving) {
      // from the driver's seat: you see the dashboard, the steering wheel and the bonnet (or the handlebars)
      driving.eyes(camera.position);
      for (const c of player.children) c.visible = !!c.userData.car;
      cracks(driving.model?.endsWith('_wreck'));   // a wreck's windscreen is cracked
    } else {
      cracks(false);
      camera.position.set(player.position.x - Math.sin(yaw) * 0.12, player.position.y + 1.62, player.position.z - Math.cos(yaw) * 0.12);
      for (const c of player.children) c.visible = false;
    }
    camera.lookAt(camera.position.x - Math.sin(yaw) * Math.cos(look), camera.position.y + Math.sin(look), camera.position.z - Math.cos(yaw) * Math.cos(look));
    return;
  }
  for (const c of player.children) c.visible = c.userData.card !== undefined ? !ride && !homes.inside : ride ? false : !driving.driving || !!c.userData.car || driving.rider;   // in a car you see the car, not the person (and your card, if you have one)
  cracks(false);
  if (room.active) return roomCam();
  const out = camIn; camIn = false;   // just out of a house: start behind you, not 40 m down in the room
  const pe = pitch + Math.max(0, 1.2 - pitch) * THREE.MathUtils.smoothstep(dist, 30, 300);
  camera.position.lerp(tmpC.set(Math.sin(yaw) * Math.cos(pe), Math.sin(pe), Math.cos(yaw) * Math.cos(pe)).multiplyScalar(dist).add(player.position), out ? 1 : 0.18);
  camera.lookAt(player.position.x, player.position.y + 1.6, player.position.z);
}
// in a house: the camera hangs on a boom from just above your head, over your right shoulder (you stand a
// little left of the middle, so the room and the people in it stay in view); the boom shortens at walls
// and tall furniture (interior.js camera) and the camera eases after you instead of jumping. Seated:
// higher, so the sofa's back does not hide you. Coming in, it starts in place (no fly-down from the street).
let camDt = 1 / 60, camIn = false;
const camLook = new THREE.Vector3(), head = new THREE.Vector3();
function roomCam() {
  const snap = !camIn; camIn = true;
  const pe = THREE.MathUtils.clamp(pitch, sat ? 0.5 : 0.1, 0.8), d = sat ? 2.4 : dist;
  head.set(player.position.x + Math.cos(yaw) * 0.3, player.position.y + (sat ? 1.0 : 1.35), player.position.z - Math.sin(yaw) * 0.3);
  room.clamp(head, 0.3);
  tmpC.set(Math.sin(yaw) * Math.cos(pe), Math.sin(pe), Math.cos(yaw) * Math.cos(pe)).multiplyScalar(d).add(head);
  room.camera(tmpC, head);
  const k = snap ? 1 : 1 - Math.exp(-camDt * 9);
  camera.position.lerp(tmpC, k); camLook.lerp(head, k); if (snap) camLook.copy(head); camera.lookAt(camLook);
  // pushed up against your back: leave your body out rather than fill the screen with it
  if (avatar.model) avatar.model.visible = camera.position.distanceTo(camLook) > 0.55;
}
// scratch vectors for the frame loop (nothing is made per frame)
const tmpC = new THREE.Vector3(), tmpF = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpM = new THREE.Vector3();
const camAt = new THREE.Vector3(), camQ = new THREE.Quaternion();
// someone else (or their car) within 100 m: their shadow moves
function peerNear() {
  const peers = social?.presence?.peers; if (!peers) return false;
  for (const q of peers.values()) { const g = q.player?.group.position; if (g && Math.hypot(g.x - player.position.x, g.z - player.position.z) < 100) return true; }
  return false;
}
function frame(now) {
  const dt = Math.min((now - last) / 1000, AGENT ? 0.1 : 0.05); last = now; camDt = dt;
  solids.beginFrame();

  // apply decoded squares within a small per-frame time budget: one near square (the big one) per frame,
  // far squares as the budget allows
  const t0 = performance.now(); let nearDone = false;
  for (let k = 0; k < ready.length && performance.now() - t0 < 6;) {
    if (ready[k].level === 'near') { if (nearDone) { k++; continue; } nearDone = true; }
    applySquare(ready.splice(k, 1)[0]);
  }
  // loading screen: the second half of the bar is the streets around the start position; it goes away
  // once all of those are in (or after 25 s, so a slow square never keeps the player out)
  if (!loaded) {
    let need = 0, have = 0;
    for (const [k, lv] of wanted) if (lv === 'near') { need++; if (tiles.get(k)?.level === 'near') have++; }
    if (need) progress(0.08 + 0.37 * carsProg + 0.55 * have / need, carsProg < 1 ? 'Parking the cars' : `Building the streets ${have} of ${need}`);
    if ((need && have === need && carsProg >= 1) || now > 25000) {
      loaded = true; progress(1, 'Ready');
      const el = document.getElementById('loading'); el.classList.add('done'); setTimeout(() => el.remove(), 450);
    }
  }

  if (needUnstick && unstick()) needUnstick = false;
  const mode = you.mode;
  if (mode === 'fly') orbit.update();
  else if (mode === 'passenger') {
    // the driver's car carries you. When they get out it stays in the street and you sit on in it
    // (E to get out, or they get back in and drive on); if they leave altogether, so do you.
    const parkedCar = ride.parked?.sx !== undefined && !ride.car ? ride.parked : null;
    if (parkedCar) {
      seatAt(parkedCar.model, parkedCar.sx, parkedCar.sz, parkedCar.h, player.position); player.rotation.y = parkedCar.h;
      if (!ride.waiting) { ride.waiting = true; note(`🚗 ${ride.name || 'Your friend'} got out. E to get out too, or wait for them.`); carBtn(true); }
    } else if (!ride.player || !ride.car || isPassenger(ride.car) || !social?.presence.peers.has(ride.id)) toggleCar();
    else {
      ride.waiting = false;
      seat(ride, player.position); player.rotation.y = ride.player.group.rotation.y;
      const h = ride.player.group.rotation.y, f = FRONT[carModel(ride.car)] ?? 1, behind = Math.atan2(-Math.cos(h) * f, Math.sin(h) * f);
      if (!dragging) { let d = behind - yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); yaw += d * Math.min(1, dt * 2.5); }
    }
    chaseCam();
  }
  else if (mode === 'car' || mode === 'bike') {
    // W/S or the joystick forward/back: throttle and brake; A/D or sideways: steer; Shift: faster
    const jx = Math.abs(joy.x) > 0.15 ? joy.x : 0, jy = Math.abs(joy.y) > 0.15 ? -joy.y : 0;
    const throttle = THREE.MathUtils.clamp((keys['w'] || keys['arrowup'] ? 1 : 0) - (keys['s'] || keys['arrowdown'] ? 1 : 0) + jy, -1, 1);
    const steer = THREE.MathUtils.clamp((keys['a'] || keys['arrowleft'] ? 1 : 0) - (keys['d'] || keys['arrowright'] ? 1 : 0) - jx, -1, 1);
    let cmd = { throttle, steer, boost: keys['shift'] || Math.hypot(joy.x, joy.y) > 0.95 };
    if (autopilot.active) {
      if (throttle || steer) stopAuto('🧭 Autopilot off. Your wheel.');
      else {
        const [fx, fz] = driving.forward, a = autopilot.drive(dt, { x: player.position.x, z: player.position.z, fx, fz, speed: driving.speed });
        if (a.hop) { driving.place(a.hop[0], a.hop[1], a.toward[0], a.toward[1]); }
        if (a.arrived) stopAuto('🏁 You have arrived: ' + autopilot.label + '.');
        else cmd = a;
      }
    }
    driving.update(dt, cmd);
    // the camera swings round behind the car while it moves, unless you are looking around
    const [fx, fz] = driving.forward, behind = Math.atan2(-fx, -fz);
    if ((Math.abs(driving.speed) > 0.5 || firstPerson) && !dragging) { let d = behind - yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); yaw += d * Math.min(1, dt * (firstPerson ? 10 : 2.5)); }
    chaseCam();
  }
  else if (mode === 'down' || mode === 'flung') { flingStep(dt); chaseCam(); }
  else if (mode === 'door') { homes.update(dt, false); chaseCam(); }
  else {
    const fwd = tmpF.set(-Math.sin(yaw), 0, -Math.cos(yaw)), right = tmpR.set(-fwd.z, 0, fwd.x), v = tmpM.set(0, 0, 0);
    if (keys['w'] || keys['arrowup']) v.add(fwd); if (keys['s'] || keys['arrowdown']) v.sub(fwd);
    if (keys['a'] || keys['arrowleft']) v.sub(right); if (keys['d'] || keys['arrowright']) v.add(right);
    const jm = Math.hypot(joy.x, joy.y);
    if (jm > 0.15) v.addScaledVector(fwd, -joy.y).addScaledVector(right, joy.x);
    seatStep(dt);
    if (sat && !homes.inside) { sat = null; seatMove = null; seatK = 0; sitBtn(true); }   // went outside (Step outside): nothing to stand up from
    if (sat && (v.lengthSq() > 0 || goal)) { standUp(); if (v.lengthSq() > 0) stopWalk(); v.set(0, 0, 0); }   // a click elsewhere: get up first, then go
    if (v.lengthSq() > 0) stopWalk();
    if (faceGoal && !goal) faceStep();
    // walk, or run with Shift or the joystick pushed to its edge; click-to-go speeds up for long trips
    // indoors a calmer pace (1.3 m/s, 3.5 running): a living room is a few strides across
    const IN = room.active, RUN = IN ? 3.5 : 6, WALK = IN ? 1.3 : 1.8;
    let speed = swim.on ? (keys['shift'] || jm > 0.9 ? SWIM_FAST : SWIM_MS) : keys['shift'] || jm > 0.9 ? RUN : jm > 0.15 ? (IN ? 0.9 : 1.2) + (WALK - (IN ? 0.9 : 1.2)) * jm : WALK;
    if (goal && !sat) {
      const to = (detour || goal).clone().sub(player.position); to.y = 0; const d = to.length();
      // a person's click-to-go speeds up on long trips; an agent walks (1.8 m/s) or runs (6 m/s) like anyone on foot
      const boost = swim.on ? speed : AGENT ? (AGENT.run ? RUN : WALK) : IN ? Math.min(RUN, Math.max(speed, d / 2.5)) : Math.max(speed, d / 2.5);
      if (d < 0.4) { if (detour) { const q = detourQ.shift(); detour = q ? new THREE.Vector3(q[0], 0.15, q[1]) : null; } else arrive(); } else { v.copy(to); speed = Math.min(boost * dt, d) / dt; }
      marker.material.opacity = 0.5 + 0.4 * Math.sin(now / 150);
    }
    if (v.lengthSq() > 0) {
      v.normalize().multiplyScalar(speed * dt);
      const p0 = player.position;
      // bumping into something: slide along it, turning off the way you push as little as you can (any
      // angle: a house and its sofas are turned to face the street, not the map's axes)
      if (!blocked(p0.x, p0.z) && blocked(p0.x + v.x, p0.z + v.z)) {
        const L = Math.hypot(v.x, v.z), a0 = Math.atan2(v.x, v.z); let ok = false;
        for (const da of SLIDE) { const a = a0 + da, k = L * Math.cos(da); if (!blocked(p0.x + Math.sin(a) * k, p0.z + Math.cos(a) * k)) { v.set(Math.sin(a) * k, 0, Math.cos(a) * k); ok = true; break; } }
        if (!ok) v.set(0, 0, 0);
      }
      if (goal && v.lengthSq() < 1e-6) { if ((stuck += dt) > (AGENT || room.active ? 0.3 : 0.6)) { stuck = 0; if (!((AGENT || room.active) && sidestep())) stopWalk(); } } else stuck = 0;
      player.position.add(v);
      movedThisFrame = Math.hypot(v.x, v.z);
      if (v.lengthSq() > 1e-8) {
        // turn smoothly instead of snapping to the new direction
        const target = Math.atan2(v.x, v.z);
        let d = target - player.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
        player.rotation.y += d * Math.min(1, dt * 12);
      }
    }
    chaseCam();
  }
  if (!you.atHome) homes.update(dt, you.can('door'));
  if ((wantT += dt) > 0.3) { wantT = 0; updateWanted(); for (const t of parked.tiles) if (updateCars(t)) shadowDirty = true; }
  if ((placeT += dt) > 0.5) {
    placeT = 0;
    const s = (driving.driving ? Math.round(Math.abs(driving.speed) * 3.6) + ' km/h  ·  ' + (autopilot.active ? apLine() : '') : '') + nearestPlace();
    if (s !== placeText) place.textContent = placeText = s;
    carBtn(); swimBtn(); sitBtn();
  }

  // only the 12 nearest signs, rescaled with distance
  if ((signT += dt) > 0.25) {
    signT = 0;
    const list = [...signs].map(s => [s, camera.position.distanceTo(s.getWorldPosition(tmpO.position))]).sort((a, b) => a[1] - b[1]);
    list.forEach(([s, d], k) => { s.visible = k < 12 && d < 260 + dist; const sc2 = THREE.MathUtils.clamp(d / 40, 0.6, 4); s.scale.set(s.userData.base * sc2, 2.2 * sc2, 1); });
  }

  walker.stepJump(dt, player.position.x, player.position.z);
  animateAvatar(dt, jump.phase === 'air' ? 0 : movedThisFrame); movedThisFrame = 0;
  social?.update(dt, driving.driving ? Math.abs(driving.speed) : ride ? ride.speed || 0 : fling.on && !fling.down ? Math.hypot(fling.vx, fling.vz) : avatar.speed);
  if (health.out) {
    if ((health.out -= dt) <= 0) { health.out = 0; health.hp = HEALTH; fling.down = Math.max(fling.down, 2.5); note('🌅 You come round. Full health again.'); }
    showHealth();
  } else if (health.hp < HEALTH) { health.hp = Math.min(HEALTH, health.hp + dt / 4); if ((health.showT = (health.showT || 0) + dt) > 1) { health.showT = 0; showHealth(); } }
  // other people going in or out of a house: their door opens here too
  if ((health.doorT = (health.doorT || 0) + dt) > 0.25) {
    health.doorT = 0;
    for (const q of social?.presence.peers.values() || []) if (q.pose === POSE.door && q.player) homes.openNear(q.player.group.position.x, q.player.group.position.z);
  }
  if (card.level && (card.t -= dt) <= 0) { card.level = 0; note('Card gone. Thanks for driving carefully.'); }
  showCard(player, card.level, driving.driving ? 2.3 : 2.25);
  driving.tick(dt, player.position);
  waterTime.value = (now / 1000) % 1e4;   // the ripples
  if (birdsLater.length) birdsLater.shift()();
  birds.update(dt, player.position.x, player.position.z);
  // a bike has no radio; a passenger has the car's radio too (their own, at their own volume)
  radio.update((driving.driving && !driving.rider) || (!!ride && !(ride.car ? carModel(ride.car) : ride.parked?.model || '').startsWith('bike')));
  nav.update(dt);
  // the town's own cars and people: where I am and whether I am on foot, in a car, or flying
  me.x = player.position.x; me.z = player.position.z; me.inCar = you.seated; me.onFoot = you.onFoot; me.fly = fly;
  traffic.update(dt, me); peds.update(dt, me);
  if (swim.on) { const y = wetAt(player.position.x, player.position.z); if (y === null || driving.driving || fly) stopSwim(); else swim.y = y; }
  player.position.y = swim.on ? swim.y : (room.active ? room.floorY : 0.15) + jump.h + (fling.on ? fling.h : 0);
  // sharp shadows that follow the player
  const R = 40 + Math.min(dist, 150) * 0.9;
  sun.target.position.copy(player.position); sun.position.copy(player.position).add(room.active ? room.skyDir : SUN_OFFSET);
  if (sc.right !== R) { sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.updateProjectionMatrix(); shadowDirty = true; }
  scene.fog.near = 300 + dist; scene.fog.far = (OV ? Q.horizon : Q.far) + dist;
  // the shadow map is redrawn when something in it moved: the camera (the map follows it), me, a car,
  // a door, someone nearby; a square or the time of day changing sets shadowDirty where it happens.
  // Standing still, it is kept as it is.
  if (!camera.position.equals(camAt) || !camera.quaternion.equals(camQ) || you.seated || fling.on || jump.phase
    || homes.busy || avatar.speed > 0.02 || peerNear() || traffic.near(R) || peds.near(R)) shadowDirty = true;
  camAt.copy(camera.position); camQ.copy(camera.quaternion);
  if (shadowDirty && !room.active) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }   // indoors no shadows are drawn
  indoorView();
  hideUnderOthers();

  // an agent's headless browser draws only when the agent asks to see (rendering there is slow, and
  // a slow frame rate would make it slower than a person on foot)
  if (!AGENT || AGENT.draw > 0) { renderer.render(scene, camera); if (AGENT) AGENT.draw--; }
  frames++;
  if (now - fpsT > 500) {
    const fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now;
    let nNear = 0, nFar = 0; for (const t of tiles.values()) t.level === 'near' ? nNear++ : nFar++;
    const ri = renderer.info.render;
    perf.textContent = `${fps.toFixed(0)} fps · ${ri.calls} draw calls · ${(ri.triangles / 1e6).toFixed(2)} M triangles · squares ${nNear} near / ${nFar} far · ${inflight.size} loading`;
    window.__city.stats = { fps, calls: ri.calls, tris: ri.triangles, nNear, nFar, loading: inflight.size, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  }
  requestAnimationFrame(frame);
}
// the agent's handle (tools/mcp/toycity-mcp): only human-sized moves
let thinkUntil = 0;
if (AGENT) window.__agent = {
  think(on) { thinkUntil = on ? performance.now() + 90000 : 0; },
  // (the same goal again, as a follower sends every few hundred ms, keeps a detour in progress)
  walkTo(x, z, run) {
    if (!you.can('walk')) return false;
    AGENT.run = !!run; const same = goal && Math.hypot(goal.x - x, goal.z - z) < 0.5; goal = new THREE.Vector3(x, 0.15, z); marker.position.set(x, 0.35, z); marker.visible = true;
    if (!same) { detour = null; detourQ = []; detours = 0; const p = player.position; if (!lineClear(p.x, p.z, x, z)) sidestep(); }   // round the hedges from the start
    return true;
  },
  stop() { stopWalk(); detourQ = []; },
  get walking() { return !!goal; },
  get riding() { return ride ? ride.name || 'a friend' : null; },   // riding along in someone's car
  get rideParked() { return !!ride && !ride.car && ride.parked?.sx !== undefined; },   // ...and they got out: you sit on in it
  get stuck() { return stuck; },
  face(y) { yaw = y; },
  jump() { if (!you.can('jump')) return false; walker.startJump(); return true; },
  draw(n = 3) { AGENT.draw = n; },   // render the next few frames (for a screenshot)
  get drawing() { return AGENT.draw > 0; },
};
if (AGENT) import('./agent.js').catch(e => console.warn('agent api', e));   // window.__agentApi for tools/mcp (it also loads it itself)
window.__city = { ovTiles, solids, walker, driving, parked, radio, nav, knockDown, card, fling, homes, health, traffic, peds, birds, swim, startSwim, wetAt, groundAt, room, sitDown, standUp, get sitting() { return sat; }, get goal() { return goal; }, get faceGoal() { return faceGoal; }, setTraffic, nearestPlace, toggleCar, autopilot, autoTo, findPlace, blocked, setYaw: v => { yaw = v; }, setView: (y, p, d) => { yaw = y; pitch = p; dist = d; }, player, tiles, camera, goTo, jump, toRD, rdToWgs, ORX, ORY, info, grid, you, stats: null };
// ---------- social layer: other people, voice and background sounds (web/mp/, ?mp=0 turns it off) ----------
// It only reads the player's position and the trees and parked cars around it; nothing here depends on it.
let social = null;
function surroundings() {
  const p = player.position; let trees = 0, cars = 0;
  for (const t of tiles.values()) {
    if (t.level !== 'near') continue;
    const ox = t.group.position.x, oz = t.group.position.z;
    if (t.trees) for (let k = 0; k < t.trees.length; k += 6) if (Math.hypot(t.trees[k] + ox - p.x, t.trees[k + 2] + oz - p.z) < 40) trees++;
    if (t.cars) for (let k = 0; k < t.cars.data.length; k += 6) if (Math.hypot(t.cars.data[k] + ox - p.x, t.cars.data[k + 2] + oz - p.z) < 60) cars++;
  }
  return { green: Math.min(1, trees / 25), street: Math.min(1, (cars + 4 * traffic.near(60)) / 30), traffic: traffic.near(60), inCar: (driving.driving && !driving.rider) || (!!ride && !ride.car?.startsWith('bike')) };
}
if (params.get('mp') !== '0') import('./mp/index.js').then(m => m.start({
  scene, camera, player, toRD, fromRD, slug, params, surroundings, useAvatar, solids, goToRD: arriveNear, find: who => nav.find(who),
  vehicle: { get shared() { return ride ? 'ride:0' : driving.shared; },
    // the car I got out of, standing in the street: everyone sees it there (and my passengers sit on in it)
    get parked() { const l = driving.left; if (!l || driving.driving) return null; const [X, Y] = toRD(l.x, l.z); return { model: l.model, colour: l.color, x: X, y: Y, h: l.heading }; }, make: (name, color) => makeCar(CAR_MODELS, name, color),
    get mine() { return driving.driving ? { model: driving.model, x: player.position.x, z: player.position.z, h: player.rotation.y } : null; } }, view: { get eyes() { return firstPerson; }, set eyes(v) { setFirstPerson(v); } },
  hud: document.getElementById('mp'), knockDown, homes, ground: groundAt, room,
  // what others see of you besides where you are: your card, lying flat or flying, and how high you are
  // caps: what I can do, told to everyone ('v' = can hear and talk). On by default in a browser,
  // off with the 📞 Calls button; an agent (?agent=1) has a voice only if it joined with one (&voice=1)
  // 't' = an agent working out its reply (tools/mcp sets it when a say/listen result has gone to the
  // model, clears it when it speaks or acts): others see a thought bubble. It clears by itself after 90 s.
  body: { get caps() { return (voiceCap ? 'v' : '') + (thinkUntil > performance.now() ? 't' : ''); }, setVoice(on) { voiceCap = on; if (!AGENT) localStorage.setItem('toycity.calls', on ? 'on' : 'off'); },
    get autoAnswer() { return !!AGENT && voiceCap; },
    get card() { return card.level; }, get pose() { return you.pose; }, get y() { return sat ? SEATED : +(swim.on ? swim.y - 0.15 : fling.on ? fling.h : jump.h).toFixed(2); } },
})).then(s => { social = s; window.__city.social = s; }).catch(e => { console.warn('multiplayer unavailable', e); document.getElementById('mp').textContent = 'Multiplayer unavailable right now'; });

setFirstPerson(localStorage.getItem('toycity.view') === 'eyes');
updateWanted();
requestAnimationFrame(frame);
if (params.get('drive')) import('./drive.js').then(m => m.run(window.__city, +params.get('drive'), +(params.get('len') || 2400), +(params.get('angle') || 0)));
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
