// People: realistic personas made by tools/personas.py, plus our dressed Xbot (models/person.glb, made
// by tools/dress_person.py), whose clips everyone uses. Every persona has a Mixamo-named skeleton, so all of them share person.glb's idle /
// walk / run clips. Bone orientations differ between rigs, so the clips are retargeted once per
// persona (world-space, by bone name), with the hip height scaled to the persona's proportions.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// Everyone gets a random person (persona) and outfit on their first visit, kept on that device.
// `clothes` lists each persona's garment materials, recoloured per outfit; `hair` is tinted.
export const PERSONAS = [
  { id: 'classic', file: 'person.glb' },   // fallback only: the toy person
  { id: 'zuri', file: 'persona_zuri.glb', height: 1.72,
    clothes: { top: ['Striped Jacket'], bottom: ['Black Jeans'], shoes: ['Shoesmat'] } },
  // not yet: her hands come out turned (Rigify hand rest pose); tools/personas.py makes the file
  // { id: 'stacey', file: 'persona_stacey.glb', height: 1.68,
  //   clothes: { top: ['Human.toigo_turtleneck_halter_top'], bottom: ['Human.toigo_harem_pants'], shoes: ['Human.culturalibre_sneakers'] },
  //   hair: ['Human.culturalibre_hair_13'] },
  { id: 'billy', file: 'persona_billy.glb', height: 1.8,
    clothes: { top: ['Baju_unique_t shirt'], bottom: ['Baju_unique_pants'], shoes: ['sepatu.002', 'sepatu.003'] } },
];
const PEOPLE = PERSONAS.filter(p => p.clothes);
// a look is "persona:outfit", e.g. "stacey:4821"
export function parseLook(s) {
  const [id, o] = String(s || '').split(':'), p = PEOPLE.find(x => x.id === id), outfit = +o;
  return p && Number.isInteger(outfit) && outfit >= 0 && outfit < 1e4 ? { persona: id, outfit } : null;
}
export const randomLook = () => PEOPLE[Math.floor(Math.random() * PEOPLE.length)].id + ':' + Math.floor(Math.random() * 1e4);
// mine: ?look=stacey:12 tries one out without saving it
export function myLook() {
  const q = new URLSearchParams(location.search).get('look');
  if (parseLook(q)) return q;
  let l = localStorage.getItem('toycity.look');
  if (!parseLook(l)) localStorage.setItem('toycity.look', l = randomLook());
  return l;
}
const GARMENT = [0x1f2a44, 0x3a3f45, 0x55603a, 0x6d1f2b, 0xc89b2c, 0x3b5f8a, 0xcbb89a, 0xe8e4dc, 0x24543a,
  0x9a4a26, 0x8a8d91, 0x161616, 0x8fb3d4, 0xd98ca0, 0x5b3a6e, 0xb5462f];
const HAIR = [0x2a1a10, 0x4a2e1a, 0x7a5232, 0xb08a50, 0x1a1a1a, 0x8a3a20];
// Recolour one persona's clothes for an outfit number. Garments lose their printed pattern but keep
// their fabric folds (normal map); outfit 0 is the original clothing.
export function dress(model, look) {
  const l = parseLook(look); if (!l || !l.outfit) return;
  const p = PEOPLE.find(x => x.id === l.persona);
  let s = l.outfit * 2654435761 >>> 0;
  const rnd = n => { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; return s % n; };
  const colour = {};
  for (const [part, names] of Object.entries(p.clothes)) { const c = rnd(5) ? GARMENT[rnd(GARMENT.length)] : null; for (const n of names) colour[n] = c; }
  for (const n of p.hair || []) colour[n] = 'hair';
  const hair = HAIR[rnd(HAIR.length)];
  model.traverse(o => {
    if (!o.isMesh || !(o.material.name in colour)) return;
    const c = colour[o.material.name]; if (c === null) return;
    o.material = o.material.clone(); o.userData.own = true;
    if (c === 'hair') o.material.color.setHex(hair).multiplyScalar(2.2);
    else { o.material.map = null; o.material.color.setHex(c); }
  });
}
const loader = new GLTFLoader(), cache = new Map();
const load = (base, file) => cache.get(file) || cache.set(file, loader.loadAsync(new URL('models/' + file, base).href)).get(file);
// Retarget a clip from the Xbot (source) onto another Mixamo-named skeleton (target), in world space:
// every frame, each bone gets the source bone's rotation relative to its rest pose, applied on top
// of the target bone's own rest pose. The hips also carry the source's height change, scaled.
const _q = new THREE.Quaternion(), _p = new THREE.Quaternion(), _v = new THREE.Vector3();
// bone -> the next bone along it, to compare which way bones point in the two rest poses
const NEXT = { Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head' };
for (const s of ['Left', 'Right']) {
  Object.assign(NEXT, { [s + 'Shoulder']: s + 'Arm', [s + 'Arm']: s + 'ForeArm', [s + 'ForeArm']: s + 'Hand', [s + 'Hand']: s + 'HandMiddle1',
    [s + 'UpLeg']: s + 'Leg', [s + 'Leg']: s + 'Foot', [s + 'Foot']: s + 'ToeBase' });
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (const k of [1, 2]) NEXT[s + 'Hand' + f + k] = s + 'Hand' + f + (k + 1);
}
// rotation taking the frame (direction a, second direction b) onto (c, d)
function frameTurn(a, b, c, d) {
  const basis = (x, y) => { const z = new THREE.Vector3().crossVectors(x, y).normalize(), y2 = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x.clone().normalize(), y2.normalize(), z)); };
  return basis(c, d).multiply(basis(a, b).invert());
}
function retarget(src, target, clip, fps = 30) {
  const S = SkeletonUtils.clone(src.scene); S.updateMatrixWorld(true);
  const tBones = {}; target.traverse(o => { if (o.isBone) tBones[o.name] = o; });
  const pairs = [], sBones = {};
  S.traverse(o => { if (o.isBone) sBones[o.name] = o; });
  S.traverse(o => { if (o.isBone && tBones[o.name] && !/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(o.name)) pairs.push({ s: o, t: tBones[o.name] }); });
  target.updateMatrixWorld(true);
  const pos = o => o.getWorldPosition(new THREE.Vector3());
  for (const pr of pairs) {
    pr.sRest = pr.s.getWorldQuaternion(new THREE.Quaternion());
    pr.tRest = pr.t.getWorldQuaternion(new THREE.Quaternion());
    pr.rest = pr.t.quaternion.clone(); pr.q = [];
    // rest poses differ (arms out in a T, or down in an A): turn the target's rest bone to point the
    // way the source's does first, so "arm hanging down" means the same thing on both bodies
    const name = pr.t.name.replace('mixamorig', ''), nx = NEXT[name];
    const sN = sBones['mixamorig' + nx], tN = tBones['mixamorig' + nx];
    if (sN && tN) {
      const sd = pos(sN).sub(pos(pr.s)).normalize(), td = pos(tN).sub(pos(pr.t)).normalize();
      // hands also turn about their own length: match the index-to-pinky direction across the palm
      const side = name.endsWith('Hand') && [sBones, tBones].map(B => B['mixamorig' + name + 'Index1'] && B['mixamorig' + name + 'Pinky1']
        && pos(B['mixamorig' + name + 'Index1']).sub(pos(B['mixamorig' + name + 'Pinky1'])));
      pr.tRest.premultiply(side && side[0] && side[1] ? frameTurn(td, side[1], sd, side[0]) : new THREE.Quaternion().setFromUnitVectors(td, sd));
    }
  }
  const hipS = S.getObjectByName('mixamorigHips'), hipT = tBones.mixamorigHips;
  const sHip0 = hipS.getWorldPosition(new THREE.Vector3()), tHip0 = hipT.getWorldPosition(new THREE.Vector3());
  const k = tHip0.y / (sHip0.y || 1);
  const mixer = new THREE.AnimationMixer(S); mixer.clipAction(clip).play();
  const times = [], hipVals = [], hipRest = hipT.position.clone();
  for (let f = 0, n = Math.max(2, Math.round(clip.duration * fps) + 1); f < n; f++) {
    const t = Math.min(clip.duration, f / fps); times.push(t);
    mixer.setTime(t); S.updateMatrixWorld(true);
    for (const pr of pairs) {
      // world target = (source now * source rest^-1) * target rest, then back into the parent's frame
      _q.copy(pr.s.getWorldQuaternion(_q)).multiply(_p.copy(pr.sRest).invert()).multiply(pr.tRest);
      pr.t.parent.getWorldQuaternion(_p).invert();
      const local = _p.multiply(_q);
      pr.q.push(local.x, local.y, local.z, local.w);
      pr.t.quaternion.copy(local);
    }
    target.updateMatrixWorld(true);
    // hips: rest position plus the source's world offset, scaled, expressed in the hips' parent frame
    const off = hipS.getWorldPosition(_v).sub(sHip0).multiplyScalar(k);
    const w = tHip0.clone().add(off); hipT.parent.worldToLocal(w);
    hipVals.push(w.x, w.y, w.z);
  }
  for (const pr of pairs) pr.t.quaternion.copy(pr.rest);
  hipT.position.copy(hipRest);
  const tracks = pairs.map(pr => new THREE.QuaternionKeyframeTrack(pr.t.name + '.quaternion', times, pr.q));
  tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', times, hipVals));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
const firstSkinned = o => { let m = null; o.traverse(x => { if (!m && x.isSkinnedMesh) m = x; }); return m; };
const worldY = b => { b.updateWorldMatrix(true, false); return b.getWorldPosition(new THREE.Vector3()).y || 1; };
const hipsY = m => { m.updateMatrixWorld(true); const h = m.getObjectByName('mixamorigHips'); return h ? h.getWorldPosition(new THREE.Vector3()).y : 1; };

// one prepared (scaled, retargeted) body per persona; every caller gets its own copy, dressed
const prepared = new Map();
async function prepare(base, p) {
  const [src, own] = await Promise.all([load(base, 'person.glb'), load(base, p.file)]);
  const model = own.scene;
  const box = new THREE.Box3().setFromObject(model);
  model.scale.multiplyScalar((p.height || 1.78) / (box.max.y - box.min.y));
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  const clips = {};
  if (p.id === 'classic') for (const n of ['idle', 'walk', 'run']) clips[n] = own.animations.find(a => a.name === n);
  else for (const n of ['idle', 'walk', 'run']) clips[n] = retarget(src, model, src.animations.find(a => a.name === n));
  return { model, clips };
}
export async function loadAvatar(base, { look = 'classic' } = {}) {
  const l = parseLook(look), p = PERSONAS.find(x => x.id === l?.persona) || PERSONAS[0];
  let t = prepared.get(p.id); if (!t) prepared.set(p.id, t = prepare(base, p));
  const { model, clips } = await t, copy = SkeletonUtils.clone(model);
  if (l) dress(copy, look);
  return { model: copy, clips, persona: p.id };
}
