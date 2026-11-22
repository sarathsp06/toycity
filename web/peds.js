// People on the pavements: they walk the streets between two spots, stop for a chat now and then, step
// aside for you and wait if you stand in their way. Drive into one and they go flying and get up again
// a few seconds later, and you get the same yellow or red card as for hitting a real player.
//
// Like the traffic, every person is a fixed loop on the region's road graph, kept to the pavement (a
// few metres right of the street's centre line), on a time table from the wall clock (ambient.js), so
// everyone playing sees the same people in the same places. Their pauses are in the time table. Being
// knocked over, waiting and stepping aside are local offsets and a local lag on that schedule, made up
// afterwards; what is shared is where they are meant to be.
//
// Each person is a persona from avatar.js with the shared idle / walk clips and the pose layer (hit,
// fall, get up, talk). Beyond 60 m the animation runs five times a second, as other players do.
//
//   const peds = createPeds({ scene, solids, autopilot, slug, T, toRD, others, count })
//   peds.update(dt, me);  peds.hit(id, vx, vz) -> true if that id was one of ours (a knock-over plays)
//   peds.setCount(n), peds.count, peds.near(r)
import * as THREE from 'three';
import { loadAvatar, poseLayer, randomLook } from './avatar.js';
import { PERSON } from './solids.js';
import { createFleet, buildLoop, usable, seed, rng, catchUp } from './ambient.js';

export const COUNT = { low: 6, mid: 12, high: 20 };
const RADIUS = 170;          // metres: seen within, dropped beyond
const NEAR = 60;             // metres: animated every frame within this, every 0.2 s beyond
const PAVEMENT = 4.8;        // metres right of the street's centre line (past a parked car or a cycle lane)
const FALL_DOWN = 0.93;      // the fall clip's moment of hitting the ground (city.js uses the same)
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const base = new URL('./', import.meta.url);

export function createPeds({ scene, solids, autopilot, slug, T, toRD, others = () => [], count = COUNT.mid }) {
  const slots = [];        // { group, model, mixer, act, pose, agent, yaw, side, animT, fling, fp }
  const fps = [];          // live footprints, one per slot (far away while unused), with the person's id
  let graph = null, nodes = null, loading = false;
  const fleet = createFleet({ slug, T, toRD, per: 6, show: count, radius: RADIUS,
    nodesOf: key => (nodes && nodes.get(key)) || [],
    plan: (id, start) => {
      const v = 1.2 + rng(seed(slug, id, 'pace'))() * 0.4;   // a pace of their own, 1.2 to 1.6 m/s
      return buildLoop(graph, { id, slug, a: start, bit: 4, route: autopilot.local.route, lane: PAVEMENT, min: 150, max: 400, maxLimit: 50, step: 20,
        speedAt: () => v,
        // at about one street corner in eight they stop for a few seconds (a chat, a shop window)
        dwellAt: (i, pts, r, corner) => (corner && r() < 0.12 ? 3 + r() * 7 : 0) });
    },
  });
  fleet.setCount(count);
  autopilot.local.graph().then(g => {
    graph = g; nodes = new Map();   // the road nodes of each map square, where streets have pavements
    for (let n = 0; n < g.xs.length; n++) {
      if (!usable(g, n, 4)) continue;
      const o = g.out[n]; let slow = true; for (let k = 1; k < o.length; k += 2) if (o[k] >> 4 > 50) slow = false;
      if (!slow) continue;
      const [X, Y] = toRD(g.xs[n], g.zs[n]), key = Math.floor(X / T) + '_' + Math.floor(Y / T);
      (nodes.get(key) || nodes.set(key, []).get(key)).push(n);
    }
  }).catch(e => console.warn('peds: no road graph', e));

  // ---------- the pool: one body per slot, made one at a time ----------
  async function slot() {
    loading = true;
    try {
      const t = await loadAvatar(base, { look: randomLook() }).catch(() => loadAvatar(base));
      const group = new THREE.Group(); group.add(t.model); group.visible = false; scene.add(group);
      const mixer = new THREE.AnimationMixer(t.model), act = {};
      for (const n of ['idle', 'walk']) { act[n] = mixer.clipAction(t.clips[n]); act[n].play(); act[n].setEffectiveWeight(n === 'idle' ? 1 : 0); }
      const s = { group, model: t.model, mixer, act, pose: poseLayer(mixer, t.clips), agent: null, yaw: 0, side: 0, animT: 0, fling: null, fp: { x: 1e9, z: 1e9, r: PERSON.r, id: '' } };
      fps.push(s.fp); slots.push(s);
    } catch (e) { console.warn('peds: no person', e); }
    loading = false;
  }
  function show(s, a) { s.agent = a; s.fp.id = a.id; s.yaw = Math.atan2(a.pos.dx, a.pos.dz); s.side = 0; s.fling = null; s.pose.set(null); s.group.visible = true; }
  function hide(s) { s.agent = null; s.group.visible = false; s.fp.x = s.fp.z = 1e9; s.fp.id = ''; s.fling = null; }
  solids.live(() => fps);

  // someone (any known player) right in front: wait; someone close by: step aside. Returns the side to
  // move to (-1, 0, 1) and sets wait.
  const near = { wait: false, side: 0 };
  function people(s, me) {
    const p = s.agent.pos; near.wait = false; near.side = 0;
    const look = (x, z) => {
      const rx = x - p.x, rz = z - p.z, d2 = rx * rx + rz * rz; if (d2 > 9) return;
      const ahead = rx * p.dx + rz * p.dz, lat = -rx * p.dz + rz * p.dx;   // lat > 0: on the person's right
      if (ahead > 0 && ahead < 1.3 && Math.abs(lat) < 0.6) near.wait = true;
      if (d2 < 2.6 && !near.side) near.side = lat > 0 ? -1 : 1;             // step away from them
    };
    if (!me.fly) look(me.x, me.z);
    for (const o of others()) look(o.x, o.z);
    return near;
  }
  // knocked flying: carried by the car's speed, then lying flat, then up again. The schedule waits.
  function flingStep(s, dt) {
    const f = s.fling, P = s.pose;
    if (f.down === 0) {
      f.ox += f.vx * dt; f.oz += f.vz * dt; f.vy -= 9.8 * dt; f.h += f.vy * dt;
      if (P.name === 'hit' && P.done) P.set('fall', { once: true });
      if (f.h <= 0) { f.h = 0; f.down = 0.001; if (P.name !== 'fall') P.set('fall', { once: true, from: FALL_DOWN }); else if (P.time < FALL_DOWN) P.time = FALL_DOWN; }
    } else {
      f.down += dt;
      if (f.down > 2.5 && P.name === 'fall') P.set('sit_exit', { once: true, fade: 0.3 });
      if (f.down > 3.6) { s.fling = null; P.set(null, { fade: 0.2 }); s.ox = f.ox; s.oz = f.oz; }
    }
  }

  function update(dt, me) {
    if (!graph) return;
    const active = fleet.update(dt, me.x, me.z);
    if (slots.length < fleet.slots && !loading && active.some((a, i) => a && !slots[i])) slot();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i], a = active[i] || null;
      if (s.agent !== a) { if (s.agent) hide(s); if (a) show(s, a); }
      if (!a) continue;
      const p = a.pos, hit = !!s.fling;
      let ox = 0, oz = 0, h = 0;
      if (hit) { flingStep(s, dt); if (s.fling) { ox = s.fling.ox; oz = s.fling.oz; h = s.fling.h; } }
      // after a fall the person walks back to the pavement over a second or two
      if (!s.fling && s.ox) { const k = Math.min(1, dt * 1.5); s.ox -= s.ox * k; s.oz -= s.oz * k; if (Math.abs(s.ox) + Math.abs(s.oz) < 0.02) s.ox = s.oz = 0; ox = s.ox; oz = s.oz; }
      const n = hit ? near : people(s, me);
      a.lag = catchUp(a.lag, dt, hit || n.wait);
      s.side += ((hit ? 0 : n.side * 0.9) - s.side) * Math.min(1, dt * 5);
      const x = p.x - p.dz * s.side + ox, z = p.z + p.dx * s.side + oz;
      s.group.position.set(x, h, z);
      s.fp.x = x; s.fp.z = z;
      if (!hit) { const want = Math.atan2(p.dx, p.dz); s.yaw += wrap(want - s.yaw) * Math.min(1, dt * 8); s.group.rotation.y = s.yaw; }
      // animation: the walk at the schedule's pace (faster while catching up), idle or a chat at a pause
      const moving = !hit && !n.wait, speed = moving ? p.v * (a.lag > 0 ? 1.5 : 1) : 0;
      if (a.d < NEAR || (s.animT += dt) > 0.2) {
        const step = a.d < NEAR ? dt : s.animT; s.animT = 0;
        if (!hit) s.pose.set(p.v === 0 && !n.wait && a.d < NEAR ? 'talk' : null, { fade: 0.3 });
        const w = THREE.MathUtils.clamp(speed / 1.4, 0, 1), k = s.pose.update(step);
        s.act.idle.setEffectiveWeight((1 - w) * k); s.act.walk.setEffectiveWeight(w * k);
        s.act.walk.timeScale = THREE.MathUtils.clamp(speed / 1.5, 0.7, 1.6);
        s.mixer.update(step);
      }
    }
  }
  // the car you drive hit this person (vehicle.js onHitPerson): true when it is one of ours
  function hit(id, vx, vz) {
    const s = slots.find(s => s.agent && s.agent.id === id); if (!s) return false;
    const sp = Math.min(14, Math.hypot(vx, vz) || 3), k = sp / (Math.hypot(vx, vz) || 1);
    s.fling = { vx: vx * k * 0.7, vz: vz * k * 0.7, vy: 3 + sp * 0.35, h: 0, ox: s.ox || 0, oz: s.oz || 0, down: 0 };
    s.pose.set('hit', { once: true });
    return true;
  }
  return {
    update, hit,
    setCount: n => { fleet.setCount(n); for (let i = n; i < slots.length; i++) if (slots[i].agent) hide(slots[i]); },
    near: r => fleet.near(r),
    get count() { return fleet.count; },
    get active() { return fleet.active; },
    get agents() { return fleet.agents; },
  };
}
