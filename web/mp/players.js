// Other players in the scene: their person and outfit, a name label
// and a ring that lights up while they talk. Each one blends idle / walk / run by its speed.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadAvatar, myLook } from '../avatar.js';
import { FRONT } from '../vehicle.js';

const SHIRTS = [0x2f6fde, 0x2a9d5c, 0xe0a020, 0x8e44ad, 0x16a3b8, 0xd35400, 0xc0392b, 0x34495e];
const base = new URL('../', import.meta.url);
export const ready = loadAvatar(base, { look: myLook() });

function label(text) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  ctx.font = 'bold 34px system-ui, sans-serif';
  const w = Math.min(Math.ceil(ctx.measureText(text).width) + 36, 560);
  c.width = w; c.height = 56;
  ctx.fillStyle = 'rgba(20,30,40,.78)'; ctx.beginPath(); ctx.roundRect(0, 0, w, 56, 28); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 34px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText(text, 18, 30);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(w / 56 * 0.32, 0.32, 1); sp.position.y = 2.15; sp.renderOrder = 20;
  return sp;
}

export function shirtFor(id) { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return SHIRTS[h % SHIRTS.length]; }

export function makePlayer(id, name, look) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7CFC9A, transparent: true, opacity: 0, depthWrite: false }));
  ring.position.y = 0.05; group.add(ring);
  const p = { id, group, model: null, mixer: null, act: null, ring, name: null, tag: null, speaking: 0, look: null };
  setName(p, name);
  setLook(p, look);
  return p;
}

// swap the body (a random person and outfit each player got on their first visit); the old one
// stays until the new one has loaded
export function setLook(p, look) {
  if (p.look === look) return;
  p.look = look;
  loadAvatar(base, { look }).catch(() => loadAvatar(base)).then(t => {
    if (p.look !== look || p.disposed) { disposeOwn(t.model); return; }
    const model = t.model, shirt = new THREE.Color(shirtFor(p.id));
    model.traverse(o => {
      if (o.isMesh && o.material.name === 'toy_shirt') { o.material = o.material.clone(); o.material.color.copy(shirt); o.userData.own = true; }
    });
    if (p.model) { p.mixer.stopAllAction(); disposeOwn(p.model); p.group.remove(p.model); }
    p.model = model; p.group.add(model); model.visible = !p.inside && (!p.carMesh || p.riding); ride(p);
    p.mixer = new THREE.AnimationMixer(model);
    p.act = {}; for (const n of ['idle', 'walk', 'run']) { p.act[n] = p.mixer.clipAction(t.clips[n]); p.act[n].play(); p.act[n].setEffectiveWeight(n === 'idle' ? 1 : 0); }
  });
}
const disposeOwn = m => m.traverse(o => { if (o.isMesh && o.userData.own) o.material.dispose(); });

export function setName(p, name) {
  if (p.name === name) return;
  p.name = name;
  if (p.tag) { p.group.remove(p.tag); p.tag.material.map.dispose(); p.tag.material.dispose(); }
  p.tag = label(name || 'Visitor'); p.group.add(p.tag);
}

const RQ = new THREE.Quaternion(), RE = new THREE.Euler();
const bendBone = (m, n, x, z = 0) => { const b = m.getObjectByName('mixamorig' + n); if (b) b.quaternion.multiply(RQ.setFromEuler(RE.set(x, 0, z))); };
// the same seated pose the local player gets on a motorbike (city.js ridePose)
function ride(p) {
  const m = p.model; if (!m) return;
  m.rotation.y = p.riding ? Math.PI / 2 : 0;
  m.position.set(p.riding ? -0.12 : 0, p.riding ? -0.12 : 0, 0);
}
function ridePose(m) {
  for (const s of ['Left', 'Right']) {
    const k = s === 'Left' ? 1 : -1;
    bendBone(m, s + 'UpLeg', -1.35, -k * 0.12); bendBone(m, s + 'Leg', 1.5);
    bendBone(m, s + 'Arm', -0.9, k * 0.35); bendBone(m, s + 'ForeArm', 0, k * 0.25);
  }
  bendBone(m, 'Spine', 0.35);
}

// a passenger seen in the car they ride in (model: that car's model), or hidden when no car is near
export function seatIn(p, model) {
  p.seat = model && model !== 'bike' ? model : model === 'bike' ? 'bike' : null;
  if (!p.model) return;
  p.model.visible = !!p.seat;
  const f = FRONT[p.seat] ?? 1;   // face the bonnet
  p.model.rotation.y = p.seat ? f * Math.PI / 2 : 0;
  p.model.position.set(0, p.seat ? (p.seat === 'bike' ? -0.12 : -0.42) : 0, 0);   // sitting: the hips drop onto the seat
}
function sitPose(m) {   // knees up, hands in the lap
  for (const s of ['Left', 'Right']) {
    const k = s === 'Left' ? 1 : -1;
    bendBone(m, s + 'UpLeg', -1.45, -k * 0.08); bendBone(m, s + 'Leg', 1.45);
    bendBone(m, s + 'Arm', -0.5, k * 0.9); bendBone(m, s + 'ForeArm', 0, k * 0.6);
  }
}

export function animate(p, speed, dt) {
  if (p.seat) speed = 0;
  if (p.riding) speed = 0;   // sitting still on the bike, whatever its speed
  const w = THREE.MathUtils.clamp(speed / 1.4, 0, 1), r = THREE.MathUtils.clamp((speed - 2.2) / 1.8, 0, 1);
  if (p.mixer) {
  p.act.idle.setEffectiveWeight(1 - w); p.act.walk.setEffectiveWeight(w * (1 - r)); p.act.run.setEffectiveWeight(w * r);
  p.act.walk.timeScale = THREE.MathUtils.clamp(speed / 1.4, 0.6, 1.6);
  p.mixer.update(dt);
  if (p.riding) ridePose(p.model);
  else if (p.seat) p.seat === 'bike' ? ridePose(p.model) : sitPose(p.model);
  }
  p.ring.material.opacity += ((p.speaking > 0.02 ? 0.9 : 0) - p.ring.material.opacity) * Math.min(1, dt * 10);
}

// someone driving: show their car instead of their person (make builds it from the game's car models)
export function setVehicle(p, car, make) {
  if (p.carMesh) { p.carMesh.removeFromParent(); p.carMesh.traverse(o => { if (o.isMesh && o.userData.own) o.material.dispose(); }); p.carMesh = null; }
  const [name, col] = (car || '').split(':');
  p.inside = name === 'ride';   // a passenger: inside someone else's car, so not drawn at all
  if (p.inside) { if (p.model) p.model.visible = false; p.ring.visible = false; p.tag.visible = false; p.riding = false; return; }
  p.seat = null;
  p.tag.visible = true;
  if (name && make) { p.carMesh = make(name, parseInt(col, 16)); if (p.carMesh) { p.carMesh.position.y = -0.15; p.group.add(p.carMesh); } }
  p.riding = name === 'bike';   // a motorbike shows its rider, sitting (see ride below)
  if (p.model) { p.model.visible = !p.carMesh || p.riding; ride(p); }
  p.ring.visible = !p.carMesh;
}

// a yellow (1) or red (2) card over someone who knocked a person over; and flying (1) or lying flat (2) after being hit
const CARDS = {};
function cardMat(level) {
  if (CARDS[level]) return CARDS[level];
  const c = document.createElement('canvas'); c.width = 64; c.height = 88;
  const x = c.getContext('2d'); x.fillStyle = level > 1 ? '#e02424' : '#ffd21f';
  x.beginPath(); x.roundRect(6, 4, 52, 80, 8); x.fill(); x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 3; x.stroke();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return (CARDS[level] = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
}
export function setCard(p, level, pose) {
  if (p.cardLevel !== level) {
    if (p.card) { p.group.remove(p.card); p.card = null; }
    if (level) { p.card = new THREE.Sprite(cardMat(level)); p.card.scale.set(0.42, 0.58, 1); p.card.renderOrder = 21; p.group.add(p.card); }
    p.cardLevel = level;
  }
  if (p.card) p.card.position.y = p.carMesh ? 2.3 : 2.6;
  if (p.model && !p.riding && !p.carMesh) {
    p.spin = pose === 1 ? (p.spin || 0) + 0.15 : 0;
    p.model.rotation.x = pose === 1 ? -p.spin : pose === 2 ? -Math.PI / 2 : 0;
    p.model.position.y = pose === 2 ? 0.12 : 0;
  }
}

export function disposePlayer(p) {
  setVehicle(p, '');
  p.group.removeFromParent();
  p.disposed = true;
  if (p.model) disposeOwn(p.model);
  p.ring.geometry.dispose(); p.ring.material.dispose();
  p.tag.material.map.dispose(); p.tag.material.dispose();
  p.mixer?.stopAllAction();
}
