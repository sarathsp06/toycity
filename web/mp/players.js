// Other players in the scene: their chosen persona (the classic person gets a shirt colour of its own), a name label
// and a ring that lights up while they talk. Each one blends idle / walk / run by its speed.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadAvatar } from '../avatar.js';

const SHIRTS = [0x2f6fde, 0x2a9d5c, 0xe0a020, 0x8e44ad, 0x16a3b8, 0xd35400, 0xc0392b, 0x34495e];
// one loaded template per persona, cloned for every player who picked it
const templates = new Map();
const template = id => templates.get(id) || templates.set(id, loadAvatar(new URL('../', import.meta.url), { persona: id })).get(id);
export const ready = template('classic');

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

export function makePlayer(id, name, persona = 'classic') {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7CFC9A, transparent: true, opacity: 0, depthWrite: false }));
  ring.position.y = 0.05; group.add(ring);
  const p = { id, group, model: null, mixer: null, act: null, ring, name: null, tag: null, speaking: 0, persona: null };
  setName(p, name);
  setPersona(p, persona);
  return p;
}

// swap the body; the old one stays until the new persona has loaded
export function setPersona(p, persona) {
  if (p.persona === persona) return;
  p.persona = persona;
  template(persona).catch(() => template('classic')).then(t => {
    if (p.persona !== persona || p.disposed) return;
    const model = SkeletonUtils.clone(t.model), shirt = new THREE.Color(shirtFor(p.id));
    model.traverse(o => {
      if (!o.isMesh) return;
      o.frustumCulled = false; o.castShadow = true;
      if (o.material.name === 'toy_shirt') { o.material = o.material.clone(); o.material.color.copy(shirt); o.userData.own = true; }
    });
    if (p.model) { p.mixer.stopAllAction(); disposeOwn(p.model); p.group.remove(p.model); }
    p.model = model; p.group.add(model);
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

export function animate(p, speed, dt) {
  const w = THREE.MathUtils.clamp(speed / 1.4, 0, 1), r = THREE.MathUtils.clamp((speed - 2.2) / 1.8, 0, 1);
  if (p.mixer) {
  p.act.idle.setEffectiveWeight(1 - w); p.act.walk.setEffectiveWeight(w * (1 - r)); p.act.run.setEffectiveWeight(w * r);
  p.act.walk.timeScale = THREE.MathUtils.clamp(speed / 1.4, 0.6, 1.6);
  p.mixer.update(dt);
  }
  p.ring.material.opacity += ((p.speaking > 0.02 ? 0.9 : 0) - p.ring.material.opacity) * Math.min(1, dt * 10);
}

export function disposePlayer(p) {
  p.group.removeFromParent();
  p.disposed = true;
  if (p.model) disposeOwn(p.model);
  p.ring.geometry.dispose(); p.ring.material.dispose();
  p.tag.material.map.dispose(); p.tag.material.dispose();
  p.mixer?.stopAllAction();
}
