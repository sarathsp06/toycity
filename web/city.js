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
import { loadAvatar, myLook } from './avatar.js';
import { createSolids, footprintsOf, PERSON } from './solids.js';
import { createDriving, makeCar, carKey, footprintOf, FRONT } from './vehicle.js';
import { createAutopilot } from './autopilot.js';
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
const HAVE = new Set(info.squares.map(([i, j]) => i + '_' + j));
const CHARS = '0123456789abcdefghijklmnopqrstuvwxyz-/ ';
document.getElementById('title').textContent = info.title;
document.title = 'Toy City · ' + info.title;
{ const n = document.querySelector('#loading .name'); if (n) n.textContent = info.title; }

// one world origin in RD metres; three.js x = east, z = -north
const sx = info.start ? info.start.x : info.squares.reduce((s, [i]) => s + (i + 0.5) * T, 0) / info.squares.length;
const sy = info.start ? info.start.y : info.squares.reduce((s, [, j]) => s + (j + 0.5) * T, 0) / info.squares.length;
const ORX = Math.round(sx), ORY = Math.round(sy);
const toRD = (x, z) => [x + ORX, ORY - z];

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
const sky = new Sky(); sky.scale.setScalar(5000);
{
  const u = sky.material.uniforms; u.turbidity.value = 4; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(SUN_OFFSET).normalize();
  scene.add(sky);
  const pm = new THREE.PMREMGenerator(renderer), env = new THREE.Scene(); env.add(sky.clone());
  scene.environment = pm.fromScene(env).texture; scene.environmentIntensity = 0.45;
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
M.water = std({ color: 0x3d6f8f, roughness: 0.12, metalness: 0.15 });
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
  const parts = [], r = TX.rng(11);
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
function qGeo(buf, g) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(buf, g.pos[0] , g.pos[1]), 3));
  geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Int8Array(buf, g.nrm[0], g.nrm[1]), 4), 3, 0, true));
  if (g.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, g.uv[0], g.uv[1]), 2));
  if (g.col) geo.setAttribute('color', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Uint8Array(buf, g.col[0], g.col[1]), 4), 3, 0, true));
  geo.setIndex(new THREE.BufferAttribute(g.i32 ? new Uint32Array(buf, g.idx[0], g.idx[1]) : new Uint16Array(buf, g.idx[0], g.idx[1]), 1));
  geo.computeBoundingSphere();
  return geo;
}
function quantGroup() { const g = new THREE.Group(); g.position.set(-QQ.ox, -QQ.oy, -QQ.oz); g.scale.setScalar(QQ.q); return g; }
function aerialTexture(bitmap, aniso) {
  const t = new THREE.Texture(bitmap); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso; t.needsUpdate = true; return t;
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
progress(0.08, 'Parking the cars');
const CAR_MODELS = await new GLTFLoader().loadAsync(new URL('./models/cars.glb?v=cab3', import.meta.url).href,
  e => e.total && progress(0.08 + 0.37 * e.loaded / e.total, 'Parking the cars')).then(g => {
  const list = [];
  for (const [name, w] of [...Object.entries(CAR_MIX), ...CAR_EXTRA.map(n => [n, 0])]) {
    const hi = g.scene.getObjectByName(name), lo = g.scene.getObjectByName(name + '_lo');
    if (!hi) continue;
    list.push({ name, w, hi: partsOf(hi), lo: partsOf(lo || hi), open: openParts(g.scene, name) });
  }
  return list;
}).catch(e => { console.warn('cars', e); return []; });
const CAR_W = CAR_MODELS.reduce((s, c) => s + c.w, 0);
function carModelAt(x, z) {
  let r = ((Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(z * 10), 19349663)) >>> 0) / 4294967296 * CAR_W;
  for (const c of CAR_MODELS) { if ((r -= c.w) < 0) return c; }
  return CAR_MODELS[0];
}
const carTiles = new Set();
function carMeshes(tile, parts, n) {
  return parts.map(([geo, mat, role]) => {
    const m = new THREE.InstancedMesh(geo, mat, n); m.count = 0;
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.userData.paint = role === 'paint';
    tile.group.add(m); return m;
  });
}
function carInstances(tile, data) {
  const cars = [];
  for (let k = 0; k < data.length; k += 6) cars.push({ k, model: carModelAt(data[k], data[k + 2]) });
  const byModel = new Map();
  for (const c of cars) (byModel.get(c.model) || byModel.set(c.model, []).get(c.model)).push(c);
  tile.cars = { data, groups: [], box: carMeshes(tile, SHAPES.car, cars.length), all: cars };
  for (const [model, list] of byModel) tile.cars.groups.push({ list, hi: carMeshes(tile, model.hi, list.length), lo: carMeshes(tile, model.lo, list.length) });
  carTiles.add(tile);
  updateCars(tile);
}
const carCol = new THREE.Color();
function fill(meshes, i, data, k) {
  tmpO.position.set(data[k], data[k + 1] - 0.02, data[k + 2]); tmpO.rotation.set(0, data[k + 3], 0); tmpO.scale.setScalar(1); tmpO.updateMatrix();
  for (const m of meshes) { m.setMatrixAt(i, tmpO.matrix); if (m.userData.paint) m.setColorAt(i, carCol.setHex(data[k + 5])); }
}
function finish(meshes, n) {
  for (const m of meshes) { m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
}
// re-split every parked car of a square into near / mid / far by its distance to the player
function updateCars(tile) {
  const { data, groups, box } = tile.cars, ox = tile.group.position.x, oz = tile.group.position.z;
  const px = player.position.x - ox, pz = player.position.z - oz;
  let nb = 0;
  for (const g of groups) {
    let nh = 0, nl = 0;
    for (const { k } of g.list) {
      if (driving?.taken.has(carKey(tile, k))) continue;   // someone is driving it
      const d = Math.hypot(data[k] - px, data[k + 2] - pz);
      if (d < CAR_NEAR) fill(g.hi, nh++, data, k);
      else if (d < CAR_MID) fill(g.lo, nl++, data, k);
      else fill(box, nb++, data, k);
    }
    finish(g.hi, nh); finish(g.lo, nl);
  }
  finish(box, nb);
}
const tmpO = new THREE.Object3D();
const solids = createSolids();   // cars, trees, lamps, furniture and other players (see solids.js)
let driving = null;              // set up once the player exists (see 'driving' below)
function instances(tile, name, data) {
  const fps = footprintsOf(name, data, tile.group.position);
  if (name === 'car') {
    fps.forEach((f, n) => { const m = carModelAt(data[n * 6], data[n * 6 + 2]).name; if (m === 'bike') Object.assign(f, footprintOf(m, f.x, f.z, f.yaw)); });
    tile.carFps = fps; fps.forEach((f, n) => { if (driving?.taken.has(tile.i + '_' + tile.j + ':' + n * 6)) f.off = true; }); }
  solids.add(tile, fps);
  if (name === 'tree') tile.trees = data;   // kept for the background sounds (more trees, more birds)
  if (name === 'car' && CAR_MODELS.length) return carInstances(tile, data);
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
    tile.group.add(m);
  }
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
    .catch(e => { if (inflight.get(key) === r) { if (!/cancel/.test(e.message)) console.warn(key, e); inflight.delete(key); } });
}

function disposeTile(t) {
  if (!t) return;
  carTiles.delete(t); solids.drop(t);
  t.group.traverse(o => { if (o.geometry && !o.isInstancedMesh) o.geometry.dispose(); if (o.isInstancedMesh) { o.dispose(); pools.delete(o); } });
  for (const tx of t.textures) tx.dispose();
  for (const m of t.materials) m.dispose();
  for (const s of t.sprites) { s.material.map.dispose(); s.material.dispose(); signs.delete(s); }
  scene.remove(t.group);
}

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
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(T, T).rotateX(-Math.PI / 2).translate(T / 2, near ? 0.02 : 0, -T / 2), groundMat);
  ground.receiveShadow = near; ground.userData.ground = true; tile.group.add(ground);
  const roofMat = std({ map: aerial, roughness: 0.8 }); tile.materials.push(roofMat);
  const q = quantGroup(); tile.group.add(q);
  const add = (file, name, mat, shadow) => {
    const g = file.header.groups[name]; if (!g) return;
    const mesh = new THREE.Mesh(qGeo(file.buf, g), mat);
    mesh.castShadow = shadow && !NO_SHADOW_CAST.has(name); mesh.receiveShadow = shadow;
    if (name.startsWith('wall') || name === 'roof') mesh.userData.solid = true;
    q.add(mesh);
  };
  if (near) {
    const { b, d } = r.files;
    for (const name of Object.keys(b.header.groups)) add(b, name, name === 'roof' ? roofMat : M[name], true);
    for (const name of Object.keys(d.header.groups)) if (M[name]) add(d, name, M[name], true);
    for (const [name, [off, len]] of Object.entries(d.header.inst)) instances(tile, name, new Float32Array(d.buf, off, len));
    tile.coll = new Uint8Array(d.buf, d.header.coll[0], d.header.coll[1]);
    tile.low = d.header.low ? new Uint8Array(d.buf, d.header.low[0], d.header.low[1]) : null;
    tile.meta = d.header.meta;
    for (const [n, k, x, y] of d.header.meta.pois.slice(0, 80)) {
      const sp = label(n, /church|place_of_worship|townhall|school/.test(k) ? '#e6ecff' : '#fff8e6');
      sp.position.set(x, 9.5, -y); tile.group.add(sp); tile.sprites.push(sp); signs.add(sp);
    }
  } else {
    const { f } = r.files;
    add(f, 'wall', M.farwall, false); add(f, 'roof', roofMat, false);
  }
  disposeTile(tiles.get(key));
  tiles.set(key, tile);
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
    const key = oi + '_' + oj, d = Math.hypot(Math.max(oi * S - X, 0, X - (oi + 1) * S), Math.max(oj * S - Y, 0, Y - (oj + 1) * S));
    const have = ovTiles.get(key);
    if (d > Q.horizon + 500) { if (have && have !== 'loading') { scene.remove(have.group); have.mesh.geometry.dispose(); have.mat.dispose(); have.groundMat.dispose(); have.tex.dispose(); ovTiles.delete(key); } continue; }
    if (have) continue;
    ovTiles.set(key, 'loading');
    load({ o: url(`o/${key}.bin`) }, { a: url(`o/${key}.jpg`) }).then(({ files: { o }, images: { a } }) => {
      if (ovTiles.get(key) !== 'loading') { a.close(); return; }
      const h = o.header, buf = o.buf, geo = new THREE.BufferGeometry();
      const group = new THREE.Group(); group.position.set(oi * S - ORX, 0, -((oj + 1) * S - ORY));
      const tex = aerialTexture(a, 4), { mat, uniforms } = ovMaterial(tex);
      const groundMat = new THREE.MeshLambertMaterial({ map: tex });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2).translate(S / 2, -0.4, S / 2), groundMat);
      group.add(ground);
      let mesh = null;
      if (h.count) {
        const I = h.index[2] === 'Uint32Array' ? Uint32Array : Uint16Array;
        geo.setIndex(new THREE.BufferAttribute(new I(buf, h.index[0], h.index[1]), 1));
        geo.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(buf, h.pos[0], h.pos[1]), 3));
        const nb = new THREE.InterleavedBuffer(new Int8Array(buf, h.nrm[0], h.nrm[1]), 4);
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
  for (let b = 0; b < OV.n; b++) for (let a = 0; a < OV.n; a++) if (tiles.has((t.oi * OV.n + a) + '_' + (t.oj * OV.n + b))) m |= 1 << (a + b * OV.n);
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
    const key = i + '_' + j; if (!HAVE.has(key)) continue;
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
  if (changed) maskOverviews();
  for (const [k] of inflight) if (!wanted.has(k)) cancelSquare(k);
  const todo = [...wanted].filter(([k, lv]) => tiles.get(k)?.level !== lv && !inflight.has(k)).sort((a, b) => score.get(a[0]) - score.get(b[0]));
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
// blended by actual speed; the capsule above stays until it has loaded
const avatar = { mixer: null, actions: null, speed: 0 };
// the player's own look: a random person and outfit given on the first visit, kept on this device
async function useAvatar(look) {
  const { model, clips } = await loadAvatar(new URL('./', import.meta.url), { look });
  if (avatar.mixer) avatar.mixer.stopAllAction();
  for (const c of [...player.children]) if (!c.userData.keep) player.remove(c);   // keep the ears (voice.js)
  player.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const actions = { idle: mixer.clipAction(clips.idle), walk: mixer.clipAction(clips.walk), run: mixer.clipAction(clips.run) };
  for (const a of Object.values(actions)) { a.play(); a.setEffectiveWeight(0); }
  actions.idle.setEffectiveWeight(1);
  const bone = n => model.getObjectByName('mixamorig' + n);
  const bones = {};
  for (const n of ['Hips', 'Spine', 'Spine1', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot',
    'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm']) bones[n] = bone(n);
  Object.assign(avatar, { mixer, actions, bones, model });
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
  a.idle.setEffectiveWeight(1 - w);
  a.walk.setEffectiveWeight(w * (1 - r));
  a.run.setEffectiveWeight(w * r);
  a.walk.timeScale = THREE.MathUtils.clamp(s / WALK_MS, 0.6, 1.6);
  a.run.timeScale = THREE.MathUtils.clamp(s / RUN_MS, 0.8, 2.2);
  avatar.mixer.update(dt);
  jumpPose();
  ridePose();
}
// jump pose layered on top of the clips (the mannequin has no jump clip):
//   crouch: knees bend and the body dips before take-off
//   air:    knees tuck while rising, legs reach down again for the landing, arms swing up
//   land:   a short knee bend that absorbs the impact
const JQ = new THREE.Quaternion(), JE = new THREE.Euler();
// on a motorbike: sit down, knees up, hands forward to the handlebars; the person turns to face the bike's front
function ridePose() {
  const B = avatar.bones, m = avatar.model; if (!B || !m) return;
  const riding = driving?.rider;
  m.rotation.y = riding ? (FRONT.bike ?? 1) * Math.PI / 2 : 0;
  m.position.set(riding ? -0.12 * (FRONT.bike ?? 1) : 0, riding ? -0.12 : 0, 0);
  if (!riding) return;
  for (const s of ['Left', 'Right']) {
    bend(B[s + 'UpLeg'], -1.35, 0, (s === 'Left' ? -1 : 1) * 0.12);
    bend(B[s + 'Leg'], 1.5);
    bend(B[s + 'Arm'], -0.9, 0, (s === 'Left' ? 1 : -1) * 0.35);
    bend(B[s + 'ForeArm'], 0, 0, (s === 'Left' ? 1 : -1) * 0.25);
  }
  bend(B.Spine, 0.35);
}
function bend(b, x, y = 0, z = 0) { if (b) b.quaternion.multiply(JQ.setFromEuler(JE.set(x, y, z))); }
function jumpPose() {
  const B = avatar.bones; if (!B) return;
  let tuck = 0, crouch = 0, arms = 0;
  if (jump.phase === 'crouch') crouch = Math.sin(Math.min(jump.t / CROUCH_T, 1) * Math.PI / 2);
  else if (jump.phase === 'air') {
    const rising = jump.v > 0, k = THREE.MathUtils.clamp(jump.v / JUMP_V, -1, 1);
    tuck = rising ? 0.35 + 0.65 * (1 - k) : 1 + 0.6 * k;   // most tucked at the top of the arc
    tuck = THREE.MathUtils.clamp(tuck, 0.2, 1);
    arms = THREE.MathUtils.clamp(0.4 + 0.6 * k, 0, 1);
  } else if (jump.phase === 'land') crouch = Math.sin((1 - Math.min(jump.t / LAND_T, 1)) * Math.PI / 2) * 0.8;
  const knee = Math.max(tuck * 1.4, crouch * 1.1), hip = Math.max(tuck * 0.9, crouch * 0.75);
  if (knee + arms < 1e-3) return;
  for (const s of ['Left', 'Right']) {
    bend(B[s + 'UpLeg'], -hip);
    bend(B[s + 'Leg'], knee);
    bend(B[s + 'Foot'], -0.35 * knee);
    bend(B[s + 'Arm'], 0, 0, (s === 'Left' ? 1 : -1) * 0.7 * arms);
    bend(B[s + 'ForeArm'], 0, 0, (s === 'Left' ? 1 : -1) * 0.4 * arms);
  }
  bend(B.Spine, 0.18 * Math.max(crouch, tuck));
  // keep the feet on the ground when crouching: drop the whole body by the leg shortening
  avatar.dip = 0.32 * crouch;
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
  document.getElementById('jumpbtn').addEventListener('pointerdown', e => { e.preventDefault(); if (!jump.phase && !fly && !driving.driving) { jump.phase = 'crouch'; jump.t = 0; } });
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
driving = createDriving({ scene, player, models: CAR_MODELS, carTiles, solids, ground: (x, z) => blockedAt(x, z), note });
let walkDist = dist;
// ---------- riding along: get into a friend's car as a passenger ----------
// E next to someone who is driving puts you in their passenger seat; you move with their car until E again.
// Others see you as "ride:0" (hidden, you are inside the car). The driver's own game does the driving.
let ride = null;   // the peer whose car you are in
function driverNear() {
  const peers = window.__city?.social?.presence?.peers; if (!peers) return null;
  let best = null, bd = 4;
  for (const p of peers.values()) {
    if (!p.car || p.car.startsWith('ride') || !p.player) continue;
    const g = p.player.group.position, d = Math.hypot(g.x - player.position.x, g.z - player.position.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
// the passenger seat: beside the driver (front right), or behind the rider on a motorbike
function seat(p, out) {
  const [name] = p.car.split(':'), f = FRONT[name] ?? 1, g = p.player.group, h = g.rotation.y;
  const [lx, lz] = name === 'bike' ? [-0.6 * f, 0] : [0.2 * f, -0.38 * -f];
  return out.set(g.position.x + lx * Math.cos(h) + lz * Math.sin(h), 0.15, g.position.z - lx * Math.sin(h) + lz * Math.cos(h));
}
function toggleCar() {
  if (fly) toggleFly();
  if (ride) {
    const g = ride.player?.group, h = g ? g.rotation.y : 0;
    if (g) { player.position.x = g.position.x + Math.sin(h) * 2.2; player.position.z = g.position.z + Math.cos(h) * 2.2; }
    note('👋 Thanks for the ride, ' + (ride.name || 'friend') + '!'); ride = null; dist = walkDist; needUnstick = true;
    carBtn(); return;
  }
  if (!driving.driving) {
    // a friend driving within reach wins over any parked car: they are waiting for you
    const d = driverNear();
    if (d) {
      goal = null; marker.visible = false; jump.phase = null; jump.h = 0;
      ride = d; walkDist = dist; dist = Math.max(dist, 10); note('🚗 Riding along with ' + (d.name || 'a friend') + '. E to get out.');
      carBtn(); return;
    }
  }
  if (driving.driving) {
    stopAuto();
    const spot = driving.exit();
    player.position.x = spot.x; player.position.z = spot.z; dist = walkDist; needUnstick = false;
  } else {
    const car = driving.nearest(player.position); if (!car) return;
    goal = null; marker.visible = false; jump.phase = null; jump.h = 0;
    driving.enter(car); walkDist = dist; dist = Math.max(dist, 10); pitch = firstPerson ? 0.5 : Math.min(pitch, 0.35);
  }
  for (const t of carTiles) updateCars(t);
  carBtn(); apBtn();
}
const carButton = document.getElementById('carbtn');
function carBtn() {
  if (!carButton) return;
  const friend = !driving.driving && !ride && !fly && driverNear();
  const near = !driving.driving && !ride && !fly && driving.nearest(player.position);
  carButton.hidden = !driving.driving && !ride && !near && !friend;
  carButton.textContent = driving.driving || ride ? '🚶 Get out (E)' : friend ? '🙋 Ride along (E)' : '🚗 Get in (E)';
}
carButton?.addEventListener('click', e => { e.stopPropagation(); toggleCar(); });

// ---------- autopilot: in a car or on the bike, name a place (or click the map) and lean back ----------
// The route follows the region's OpenStreetMap streets (autopilot.js); W/A/S/D, the joystick or getting
// out takes the wheel back.
const autopilot = createAutopilot({
  // ?v: the segments carry direction, vehicle and speed flags now; a cached older file would not parse
  roadsUrl: new URL('roads.json?v=2', base).href, fromRD: (X, Y) => [X - ORX, ORY - Y],
  fromWGS: (la, lo) => { const [X, Y] = wgsToRd(la, lo); return [X - ORX, ORY - Y]; },
  toWGS: (x, z) => rdToWgs(...toRD(x, z)),
  inside: (x, z) => { const [X, Y] = toRD(x, z); return HAVE.has(Math.floor(X / T) + '_' + Math.floor(Y / T)); },
});
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
  if (e.key.toLowerCase() === 'e' && !e.repeat) toggleCar();
  if (e.key.toLowerCase() === 'f') { if (driving.driving) toggleCar(); toggleFly(); }
  if (e.key.toLowerCase() === 'v') setFirstPerson(!firstPerson);
  if (e.key.toLowerCase() === 'm') toggleMap();
  if (e.key === '-' || e.key === '_') zoomBy(1.6); if (e.key === '=' || e.key === '+') zoomBy(1 / 1.6);
  if (e.key.startsWith('Arrow')) e.preventDefault();
  if (e.key === ' ') { e.preventDefault(); if (!jump.phase && !fly && !driving.driving) { jump.phase = 'crouch'; jump.t = 0; } }
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
function toggleFly() { fly = !fly; orbit.enabled = fly; if (fly) orbit.target.copy(player.position); }

// click (not drag) to walk somewhere; in fly mode, drop in at the spot
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let goal = null;
const marker = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.2, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthTest: false }));
marker.visible = false; marker.renderOrder = 10; scene.add(marker);
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  downAt = null;
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const targets = [];
  for (const t of tiles.values()) t.group.traverse(o => { if (o.userData.ground || o.userData.solid) targets.push(o); });
  const hit = ray.intersectObjects(targets, false)[0];
  let pt;
  if (hit) {
    pt = hit.point.clone();
    if (hit.object.userData.solid && hit.face) { const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld); n.y = 0; pt.add(n.lengthSq() > 0.01 ? n.normalize().multiplyScalar(2.5) : new THREE.Vector3(camera.position.x - pt.x, 0, camera.position.z - pt.z).normalize().multiplyScalar(3)); }
  } else { const t = -ray.ray.origin.y / ray.ray.direction.y; if (!(t > 0)) return; pt = ray.ray.at(t, new THREE.Vector3()); }
  pt.y = 0.15;
  if (driving.driving) return;
  if (fly) { toggleFly(); yaw = Math.atan2(camera.position.x - pt.x, camera.position.z - pt.z); player.position.copy(pt); goal = null; marker.visible = false; return; }
  goal = pt; marker.position.set(pt.x, 0.35, pt.z); marker.visible = true;
});

// collision against the pre-built 0.5 m bitmaps of loaded near squares
// coll always blocks (walls, water, fences, tree trunks, lamp posts); low (hedges) blocks only on foot
function blockedAt(x, z) {
  const [X, Y] = toRD(x, z), i = Math.floor(X / T), j = Math.floor(Y / T), t = tiles.get(i + '_' + j);
  if (!t || !t.coll) return false;
  const col = Math.floor((X - i * T) / 0.5), row = Math.floor((Y - j * T) / 0.5), bit = row * 1000 + col;
  if ((t.coll[bit >> 3] >> (bit & 7)) & 1) return true;
  return jump.h < 0.5 && t.low && ((t.low[bit >> 3] >> (bit & 7)) & 1);
}
// jumping (Space): enough to clear a 1.1 m hedge; up to 1.3 m at the top of the arc
const jump = { h: 0, v: 0, phase: null, t: 0 };   // phase: crouch -> air -> land -> null
const GRAVITY = 14, JUMP_V = 6, CROUCH_T = 0.12, LAND_T = 0.16;
const R0 = 0.3;
let movedThisFrame = 0;
const blocked = (x, z) => blockedAt(x, z) || blockedAt(x + R0, z) || blockedAt(x - R0, z) || blockedAt(x, z + R0) || blockedAt(x, z - R0)
  || (!fly && solids.hit(x, z, PERSON.r));
let stuck = 0, needUnstick = true;
// an address point sits inside its building: once that square is loaded, stand on the address's
// own street at the closest point, facing the house; otherwise step to the nearest open spot
let arriveStreet = info.start ? info.start.label.split(',')[0].replace(/\s+\d+\s*\w?$/, '') : null;
function unstick() {
  const p = player.position;
  const [X, Y] = toRD(p.x, p.z), t = tiles.get(Math.floor(X / T) + '_' + Math.floor(Y / T));
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
  goal = null; marker.visible = false; arriveStreet = null;
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
      if (HAVE.has(Math.floor(X / T) + '_' + Math.floor(Y / T))) return [X, Y, r.name || r.display_name.split(',')[0]];
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
  goal = null; marker.visible = false;
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
  sky.visible = t.el > -6; scene.background = sky.visible ? null : new THREE.Color(0x0b1124);
  nightK = t.night;
  M.winlit.emissiveIntensity = 1.3 * nightK; M.lamphead.emissiveIntensity = 4 * nightK; M.pool.opacity = 0.75 * nightK;
  M.chargerLight.emissiveIntensity = 0.6 + 2 * nightK;
  for (const p of pools) p.visible = nightK > 0.02;
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
    if (!HAVE.has(Math.floor(X / T) + '_' + Math.floor(Y / T))) return;
    if (driving.driving) return autoTo(X - ORX, -(Y - ORY), 'the spot on the map');   // in a car: drive there
    if (fly) toggleFly();
    const far = Math.hypot(X - ORX - player.position.x, -(Y - ORY) - player.position.z) > 600;
    if (far) { player.position.set(X - ORX, 0.15, -(Y - ORY)); goal = null; marker.visible = false; updateWanted(); return; } // jump, then stream in
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
let last = performance.now(), placeT = 0, wantT = 0, signT = 0, frames = 0, fpsT = performance.now(), loaded = false;
// first-person view (V or the eye button): the camera sits at the eyes and looks where you face;
// dragging still turns and tilts the head, and your own body is hidden
function setFirstPerson(on) {
  firstPerson = on; localStorage.setItem('toycity.view', on ? 'eyes' : 'chase');
  if (on && (driving?.driving || ride)) pitch = 0.5;   // look at the road, a touch below the horizon
  const b = document.getElementById('eyesbtn'); if (b) b.setAttribute('aria-pressed', on);
  dispatchEvent(new Event('toycity:view'));
}
// in the driver's seat the dashboard is half a metre away: a closer near plane and a wider lens there
function lens(seat) {
  const near = seat ? 0.06 : 0.5, fov = seat ? 68 : 55;
  if (camera.near !== near || camera.fov !== fov) { camera.near = near; camera.fov = fov; camera.updateProjectionMatrix(); }
}
function chaseCam() {
  lens(firstPerson && (driving.driving || !!ride));
  if (firstPerson) {
    const look = 0.42 - pitch;                     // drag up and down to look up and down
    if (ride) {
      camera.position.set(player.position.x, 1.22, player.position.z);
      for (const c of player.children) c.visible = false;
    } else if (driving.driving) {
      // from the driver's seat: you see the dashboard, the steering wheel and the bonnet (or the handlebars)
      driving.eyes(camera.position);
      for (const c of player.children) c.visible = !!c.userData.car;
    } else {
      camera.position.set(player.position.x - Math.sin(yaw) * 0.12, player.position.y + 1.62, player.position.z - Math.cos(yaw) * 0.12);
      for (const c of player.children) c.visible = false;
    }
    camera.lookAt(camera.position.x - Math.sin(yaw) * Math.cos(look), camera.position.y + Math.sin(look), camera.position.z - Math.cos(yaw) * Math.cos(look));
    return;
  }
  for (const c of player.children) c.visible = ride ? false : !driving.driving || !!c.userData.car || driving.rider;   // in a car you see the car, not the person
  const pe = pitch + Math.max(0, 1.2 - pitch) * THREE.MathUtils.smoothstep(dist, 30, 300);
  const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(pe), Math.sin(pe), Math.cos(yaw) * Math.cos(pe)).multiplyScalar(dist);
  camera.position.lerp(player.position.clone().add(off), 0.18);
  camera.lookAt(player.position.x, player.position.y + 1.6, player.position.z);
}
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;

  // apply decoded squares within a small per-frame time budget
  const t0 = performance.now();
  while (ready.length && performance.now() - t0 < 6) applySquare(ready.shift());
  // loading screen: the second half of the bar is the streets around the start position; it goes away
  // once all of those are in (or after 25 s, so a slow square never keeps the player out)
  if (!loaded) {
    let need = 0, have = 0;
    for (const [k, lv] of wanted) if (lv === 'near') { need++; if (tiles.get(k)?.level === 'near') have++; }
    if (need) progress(0.45 + 0.55 * have / need, `Building the streets ${have} of ${need}`);
    if ((need && have === need) || now > 25000) {
      loaded = true; progress(1, 'Ready');
      const el = document.getElementById('loading'); el.classList.add('done'); setTimeout(() => el.remove(), 450);
    }
  }

  if (needUnstick && unstick()) needUnstick = false;
  if (fly) orbit.update();
  else if (ride) {
    // the driver's car carries you; if they get out or leave, so do you
    if (!ride.player || !ride.car || ride.car.startsWith('ride') || !window.__city.social.presence.peers.has(ride.id)) toggleCar();
    else {
      seat(ride, player.position); player.rotation.y = ride.player.group.rotation.y;
      const h = ride.player.group.rotation.y, f = FRONT[ride.car.split(':')[0]] ?? 1, behind = Math.atan2(-Math.cos(h) * f, Math.sin(h) * f);
      if (!dragging) { let d = behind - yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); yaw += d * Math.min(1, dt * 2.5); }
    }
    chaseCam();
  }
  else if (driving.driving) {
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
  else {
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), right = new THREE.Vector3(-fwd.z, 0, fwd.x), v = new THREE.Vector3();
    if (keys['w'] || keys['arrowup']) v.add(fwd); if (keys['s'] || keys['arrowdown']) v.sub(fwd);
    if (keys['a'] || keys['arrowleft']) v.sub(right); if (keys['d'] || keys['arrowright']) v.add(right);
    const jm = Math.hypot(joy.x, joy.y);
    if (jm > 0.15) v.addScaledVector(fwd, -joy.y).addScaledVector(right, joy.x);
    if (v.lengthSq() > 0) { goal = null; marker.visible = false; }
    // walk, or run with Shift or the joystick pushed to its edge; click-to-go speeds up for long trips
    let speed = keys['shift'] || jm > 0.9 ? 6 : jm > 0.15 ? 1.2 + 0.8 * jm : 1.8;
    if (goal) {
      const to = goal.clone().sub(player.position); to.y = 0; const d = to.length();
      if (d < 0.4) { goal = null; marker.visible = false; } else { v.copy(to); speed = Math.min(Math.max(speed, d / 2.5) * dt, d) / dt; }
      marker.material.opacity = 0.5 + 0.4 * Math.sin(now / 150);
    }
    if (v.lengthSq() > 0) {
      v.normalize().multiplyScalar(speed * dt);
      const p0 = player.position;
      if (!blocked(p0.x, p0.z) && blocked(p0.x + v.x, p0.z + v.z)) {
        if (!blocked(p0.x + v.x, p0.z)) v.z = 0; else if (!blocked(p0.x, p0.z + v.z)) v.x = 0; else v.set(0, 0, 0);
      }
      if (goal && v.lengthSq() < 1e-6) { if ((stuck += dt) > 0.6) { goal = null; marker.visible = false; stuck = 0; } } else stuck = 0;
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
  if ((wantT += dt) > 0.3) { wantT = 0; updateWanted(); for (const t of carTiles) updateCars(t); }
  if ((placeT += dt) > 0.5) { placeT = 0; place.textContent = (driving.driving ? Math.round(Math.abs(driving.speed) * 3.6) + ' km/h  ·  ' + (autopilot.active ? apLine() : '') : '') + nearestPlace(); carBtn(); }

  // only the 12 nearest signs, rescaled with distance
  if ((signT += dt) > 0.25) {
    signT = 0;
    const list = [...signs].map(s => [s, camera.position.distanceTo(s.getWorldPosition(tmpO.position))]).sort((a, b) => a[1] - b[1]);
    list.forEach(([s, d], k) => { s.visible = k < 12 && d < 260 + dist; const sc2 = THREE.MathUtils.clamp(d / 40, 0.6, 4); s.scale.set(s.userData.base * sc2, 2.2 * sc2, 1); });
  }

  jump.t += dt;
  if (jump.phase === 'crouch' && jump.t >= CROUCH_T) { jump.phase = 'air'; jump.v = JUMP_V; jump.t = 0; }
  else if (jump.phase === 'land' && jump.t >= LAND_T) { jump.phase = null; }
  const overHedge = () => { const h = jump.h; jump.h = 0; const b = blocked(player.position.x, player.position.z); jump.h = h; return b; };
  if (jump.onHedge && !jump.phase && !overHedge()) { jump.onHedge = false; jump.phase = 'air'; jump.v = 0; jump.t = 0; }  // stepped off the top
  if (jump.phase === 'air') {
    jump.v -= GRAVITY * dt; jump.h += jump.v * dt;
    const floor = overHedge() ? 1.0 : 0;   // a hedge is 1.1 m high; land on its top
    if (jump.v < 0 && jump.h <= floor) { jump.h = floor; jump.v = 0; jump.onHedge = floor > 0; jump.phase = 'land'; jump.t = 0; }
  }
  avatar.dip = 0;
  animateAvatar(dt, jump.phase === 'air' ? 0 : movedThisFrame); movedThisFrame = 0;
  social?.update(dt, driving.driving ? Math.abs(driving.speed) : ride ? ride.speed || 0 : avatar.speed);
  driving.tick(dt, player.position);
  player.position.y = 0.15 + jump.h - avatar.dip;
  // sharp shadows that follow the player
  const R = 40 + Math.min(dist, 150) * 0.9;
  sun.target.position.copy(player.position); sun.position.copy(player.position).add(SUN_OFFSET);
  if (sc.right !== R) { sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.updateProjectionMatrix(); }
  scene.fog.near = 300 + dist; scene.fog.far = (OV ? Q.horizon : Q.far) + dist;

  renderer.render(scene, camera);
  frames++;
  if (now - fpsT > 500) {
    const fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now;
    let nNear = 0, nFar = 0; for (const t of tiles.values()) t.level === 'near' ? nNear++ : nFar++;
    const ri = renderer.info.render;
    perf.textContent = `${fps.toFixed(0)} fps · ${ri.calls} draw calls · ${(ri.triangles / 1e6).toFixed(2)} M triangles · squares ${nNear} near / ${nFar} far · ${inflight.size} loading`;
    window.__stats = { fps, calls: ri.calls, tris: ri.triangles, nNear, nFar, loading: inflight.size, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  }
  requestAnimationFrame(frame);
}
// render cost without the browser's frame pacing: n frames, each finished on the GPU
function bench(n = 30) {
  const gl = renderer.getContext(), t0 = performance.now();
  for (let k = 0; k < n; k++) { renderer.render(scene, camera); gl.finish(); }
  return +((performance.now() - t0) / n).toFixed(2);
}
window.__city = { ovTiles, solids, driving, toggleCar, autopilot, autoTo, findPlace, blocked, setYaw: v => { yaw = v; }, setView: (y, p, d) => { yaw = y; pitch = p; dist = d; }, player, tiles, camera, goTo, bench, blocked, jump, toRD, ORX, ORY, get stats() { return window.__stats; } };
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
  return { green: Math.min(1, trees / 25), street: Math.min(1, cars / 30) };
}
if (params.get('mp') !== '0') import('./mp/index.js').then(m => m.start({
  scene, camera, player, toRD, fromRD: (X, Y) => [X - ORX, ORY - Y], slug, params, surroundings, useAvatar, solids, goToRD: arriveNear,
  vehicle: { get shared() { return ride ? 'ride:0' : driving.shared; }, make: (name, color) => makeCar(CAR_MODELS, name, color) }, view: { get eyes() { return firstPerson; }, set eyes(v) { setFirstPerson(v); } },
  hud: document.getElementById('mp'),
})).then(s => { social = s; window.__city.social = s; }).catch(e => { console.warn('multiplayer unavailable', e); document.getElementById('mp').textContent = 'Multiplayer unavailable right now'; });

setFirstPerson(localStorage.getItem('toycity.view') === 'eyes');
updateWanted();
requestAnimationFrame(frame);
if (params.get('drive')) import('./drive.js').then(m => m.run(window.__city, +params.get('drive'), +(params.get('len') || 2400), +(params.get('angle') || 0)));
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
