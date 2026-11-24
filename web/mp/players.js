// Other players in the scene: their person and outfit, a name label
// and a ring that lights up while they talk. Each one blends idle / walk / run by its speed, with a
// pose clip (riding, sitting, flying after a hit, lying, jumping, talking) layered over them.
import * as THREE from 'three';
import { loadAvatar, myLook, poseLayer } from '../avatar.js';
import { FRONT } from '../vehicle.js';
import { blobMesh } from '../interior.js';
import { POSE, FALL_DOWN, isLying, isSwimming, isPassenger, isBike, carModel } from './state.js';
// where the body goes to sit on a seat whose top is h metres up: the sit clip has the hips 0.59 m over
// the feet and 0.28 m behind them, so lift (or lower) it to rest the thighs on the seat (hip joint 8 cm
// above it) and move it forward until the hips are over the seat's point
export const sitOffset = (h = 0.45) => ({ y: h + 0.08 - 0.59, z: 0.23 });

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
  group.add(blobMesh(0.75));   // their shadow indoors (only the indoor camera draws it)
  const p = { id, group, model: null, mixer: null, act: null, pose: null, poseN: 0, up: 0, ring, name: null, tag: null, speaking: 0, look: null };
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
    p.pose = poseLayer(p.mixer, t.clips);
  });
}
const disposeOwn = m => m.traverse(o => { if (o.isMesh && o.userData.own) o.material.dispose(); });

export function setName(p, name) {
  if (p.name === name) return;
  p.name = name;
  if (p.tag) { p.group.remove(p.tag); p.tag.material.map.dispose(); p.tag.material.dispose(); }
  p.tag = label(name || 'Visitor'); p.group.add(p.tag);
}

// on the saddle of a motorbike, facing its front, the same as the local player (city.js ridePlace)
function ride(p) {
  const m = p.model; if (!m) return;
  m.rotation.y = p.riding ? Math.PI / 2 : 0;
  m.position.set(p.riding ? -0.12 : 0, p.riding ? 0.31 : 0, 0);
}

// a passenger seen in the car they ride in (model: that car's model), or hidden when no car is near
export function seatIn(p, model) {
  p.seat = model && model !== 'bike' ? model : model === 'bike' ? 'bike' : null;
  if (!p.model) return;
  p.model.visible = !!p.seat;
  const f = FRONT[p.seat] ?? 1;   // face the bonnet
  p.model.rotation.y = p.seat ? f * Math.PI / 2 : 0;
  p.model.position.set(0, p.seat ? (p.seat === 'bike' ? 0.31 : 0) : 0, 0);   // the sitting clips put the hips 0.61 m up: on the seat
}
// the pose clip for this moment: on a bike or in a car seat, flying after a hit (pose 1: the flinch,
// held), lying (2, or 4 knocked out: the fall, from the moment it hits the ground, held flat), getting
// up again after that, in the air (up, jumping), or standing still while talking
function pickPose(p, speed) {
  const P = p.pose; if (!P) return;
  if (p.riding || p.seat === 'bike') return P.set('drive');
  if (p.seat) return P.set('sit_idle');   // in a car seat
  if (p.sitting) {   // on a seat in a house: sit down once, then sit (talking: sit_talk)
    if ((P.name === 'sit_enter' && P.done) || P.name === 'sit_idle' || P.name === 'sit_talk') return P.set(p.speaking > 0.02 ? 'sit_talk' : 'sit_idle', { fade: 0.3 });
    if (P.name !== 'sit_enter') P.set('sit_enter', { once: true, fade: 0.2 });
    return;
  }
  if (p.carMesh || p.inside) return P.set(null);
  if (p.seatK > 0 && /^sit_(enter|idle|talk)$/.test(P.name)) return P.set('sit_exit', { once: true, fade: 0.15 });   // getting up
  if (isSwimming(p.poseN)) return P.set(speed > 0.25 ? 'swim' : 'swim_idle', { fade: 0.3 });
  if (p.poseN === POSE.flung) return P.set('hit', { once: true });
  if (isLying(p.poseN)) { if (P.name !== 'fall') P.set('fall', { once: true, from: FALL_DOWN }); return; }
  if (P.name === 'fall') return P.set('sit_exit', { once: true, fade: 0.3 });
  if (P.name === 'sit_exit' && !P.done && speed < 0.5) return;
  if (p.air && p.poseN !== POSE.door) return P.set('jump_loop');   // presence.js: rising or falling, not just standing higher
  P.set(p.speaking > 0.02 && speed < 0.3 ? 'talk' : null, { fade: P.name === 'sit_exit' ? 0.2 : 0.1 });
}

export function animate(p, speed, dt) {
  if (p.seat || p.sitting) speed = 0;
  // lowered onto the seat as sit_enter bends the body (about 1 s), raised again with sit_exit
  if (p.sitting) p.sitH = p.sitting.h;
  p.seatK = THREE.MathUtils.clamp((p.seatK || 0) + (p.sitting ? dt : -dt / 0.7), 0, 1);
  if (p.model && !p.seat && !p.riding) { const o = p.seatK ? sitOffset(p.sitH) : null, k = p.seatK * p.seatK * (3 - 2 * p.seatK); p.model.position.y = o ? o.y * k : 0; p.model.position.z = o ? o.z * k : 0; }
  if (p.riding) speed = 0;   // sitting still on the bike, whatever its speed
  const w = THREE.MathUtils.clamp(speed / 1.4, 0, 1), r = THREE.MathUtils.clamp((speed - 2.2) / 1.8, 0, 1);
  if (p.mixer) {
    pickPose(p, speed);
    const k = p.pose.update(dt);   // what the pose clip leaves for walking
    p.act.idle.setEffectiveWeight((1 - w) * k); p.act.walk.setEffectiveWeight(w * (1 - r) * k); p.act.run.setEffectiveWeight(w * r * k);
    p.act.walk.timeScale = THREE.MathUtils.clamp(speed / 1.4, 0.6, 1.6);
    p.mixer.update(dt);
  }
  p.ring.material.opacity += ((p.speaking > 0.02 ? 0.9 : 0) - p.ring.material.opacity) * Math.min(1, dt * 10);
}

// someone driving: show their car instead of their person (make builds it from the game's car models)
export function setVehicle(p, car, make) {
  if (p.carMesh) { p.carMesh.removeFromParent(); p.carMesh.traverse(o => { if (o.isMesh && o.userData.own) o.material.dispose(); }); p.carMesh = null; }
  const name = carModel(car), col = car ? car.slice(name.length + 1) : '';
  p.inside = isPassenger(car);   // a passenger: inside someone else's car, so not drawn at all
  if (p.inside) { if (p.model) p.model.visible = false; p.ring.visible = false; p.tag.visible = false; p.riding = false; return; }
  p.seat = null;
  p.tag.visible = true;
  if (name && make) { p.carMesh = make(name, parseInt(col, 16)); if (p.carMesh) { p.carMesh.position.y = -0.15; p.group.add(p.carMesh); } }
  p.riding = isBike(car);   // a motorbike shows its rider, sitting (see ride below)
  if (p.model) { p.model.visible = !p.carMesh || p.riding; ride(p); }
  p.ring.visible = !p.carMesh;
}

// a yellow (1) or red (2) card over someone who knocked a person over; and their pose: flying (1) or
// lying flat (2) after being hit, knocked out (4), going through a door (5); up: metres off the ground
const CARDS = {};
function cardMat(level) {
  if (CARDS[level]) return CARDS[level];
  const c = document.createElement('canvas'); c.width = 64; c.height = 88;
  const x = c.getContext('2d'); x.fillStyle = level > 1 ? '#e02424' : '#ffd21f';
  x.beginPath(); x.roundRect(6, 4, 52, 80, 8); x.fill(); x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 3; x.stroke();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return (CARDS[level] = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
}
export function setCard(p, level, pose, up = 0) {
  if (p.cardLevel !== level) {
    if (p.card) { p.group.remove(p.card); p.card = null; }
    if (level) { p.card = new THREE.Sprite(cardMat(level)); p.card.scale.set(0.42, 0.58, 1); p.card.renderOrder = 21; p.group.add(p.card); }
    p.cardLevel = level;
  }
  if (p.card) p.card.position.y = p.carMesh ? 2.3 : 2.6;
  p.poseN = pose; p.up = up;
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
