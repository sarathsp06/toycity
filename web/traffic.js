// Ambient traffic: cars driving the real streets, so the town feels lived in. Nobody is ever hurt by
// them: they stop for anyone in the road (and toot after a while), and they never drive into the car
// you are in; drive into them and your car takes a dent as it would from any parked car.
//
// Every browser shows the same cars in the same places: each car is a fixed loop over the region's road
// graph (there and back between two nodes picked by a seeded PRNG from its id), driven on a time table
// from the wall clock (see ambient.js). Stopping for someone is a local lag on that schedule, made up at
// 1.5x afterwards; since every browser sees the same players, they all derive the same lag.
//
// Per frame per visible car: one time-table lookup (a binary search), a distance to the player, a check
// against the players within 40 m, and a position/rotation write. Nothing is allocated per frame: the
// meshes are a fixed pool (one per slot, high and low detail), the footprints are reused objects.
//
//   const traffic = createTraffic({ scene, models, autopilot, solids, slug, T, toRD, others, sounds, count })
//   traffic.update(dt, me)       me: { x, z, onFoot, inCar, fly } the local player
//   traffic.setCount(n)          cars at most (0 switches it off); traffic.setNight(k) headlights
//   traffic.count, traffic.near(r)
import * as THREE from 'three';
import { makeCar, footprintOf, FRONT } from './vehicle.js';
import { createFleet, buildLoop, cornerSpeed, usable, nodesBySquare, seed, rng, catchUp } from './ambient.js';

export const COUNT = { low: 6, mid: 12, high: 20 };
const MODEL = 'suv';
const PAINTS = [0xd93a2f, 0x2d64c4, 0xf2f2f2, 0x24252a, 0x8c9299, 0x2e8b57, 0xf0b429, 0x6b3fa0, 0xc9d7e6, 0x7a4a2b, 0xe8743b, 0x1f6f8b];
const RADIUS = 350;          // metres: seen within, dropped beyond
const LOD = 90;              // metres: the low-detail body beyond this
const AHEAD = 6, AHEAD_CAR = 9;   // metres of clear road in front of a person / a car before it rolls on
const HORN_AFTER = 3, HORN_AGAIN = 9;   // seconds blocked before a toot, and between toots
const TOWN = 80;             // km/h: never faster than this, whatever the limit says
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const LIGHT = new THREE.SphereGeometry(0.12, 8, 6);
const HEAD = new THREE.MeshBasicMaterial({ color: 0xfff1c4 }), TAIL = new THREE.MeshBasicMaterial({ color: 0xff2b2b });

export function createTraffic({ scene, models, autopilot, solids, slug, T, toRD, others = () => [], sounds = () => true, count = COUNT.mid }) {
  const slots = [];       // { hi, lo, paint: [materials], fp, yaw, agent, lights: [meshes] }
  const fps = [];         // the live footprints, one per slot, parked far away while unused
  let graph = null, nodes = null, night = 0, ctx = null;
  const fleet = createFleet({ slug, T, toRD, per: 1.5, show: count, radius: RADIUS,
    nodesOf: key => (nodes && nodes.get(key)) || [],
    plan: (id, start) => buildLoop(graph, { id, slug, a: start, bit: 4, route: autopilot.local.route, lane: 1.6,
      speedAt: (limit, i, pts) => cornerSpeed(pts, i, Math.min(limit, TOWN) / 3.6, 3.5) }),
  });
  fleet.setCount(count);
  autopilot.local.graph().then(g => {
    graph = g; nodes = nodesBySquare(g, toRD, T, n => usable(g, n, 4));   // the car-usable road nodes of each map square, for the fleet
  }).catch(e => console.warn('traffic: no road graph', e));

  // ---------- the pool ----------
  const { hx: HL, hz: HW } = footprintOf(MODEL, 0, 0, 0), f0 = FRONT[MODEL] ?? 1;
  function lights(group) {
    const out = [];
    for (const [along, across, mat] of [[1, 0.62, HEAD], [1, -0.62, HEAD], [-1, 0.6, TAIL], [-1, -0.6, TAIL]]) {
      const m = new THREE.Mesh(LIGHT, mat); m.position.set(along * f0 * (HL - 0.05), along > 0 ? 0.72 : 0.8, across); m.visible = false; group.add(m); out.push(m);
    }
    return out;
  }
  function slot() {
    const hi = makeCar(models, MODEL, PAINTS[0]), lo = makeCar(models, MODEL, PAINTS[0], false, true);
    if (!hi || !lo) return null;
    lo.traverse(o => { o.castShadow = false; });
    const paint = []; for (const g of [hi, lo]) g.traverse(o => { if (o.isMesh && o.userData.own) paint.push(o.material); });
    hi.visible = lo.visible = false; scene.add(hi, lo);
    const s = { hi, lo, paint, yaw: 0, agent: null, lights: [...lights(hi), ...lights(lo)], fp: { x: 1e9, z: 1e9, hx: HL, hz: HW, yaw: 0, v: 0 } };
    fps.push(s.fp); slots.push(s);
    return s;
  }
  const paintOf = id => PAINTS[Math.floor(rng(seed(slug, id, 'paint'))() * PAINTS.length)];
  function show(s, a) {
    s.agent = a; const c = paintOf(a.id); for (const m of s.paint) m.color.setHex(c);
    s.yaw = Math.atan2(-a.pos.dz * f0, a.pos.dx * f0);
    for (const l of s.lights) l.visible = night > 0.3;
  }
  function hide(s) { s.agent = null; s.hi.visible = s.lo.visible = false; s.fp.x = s.fp.z = 1e9; }
  solids.live(() => fps);

  // ---------- the horn: a polite double toot, quieter with distance ----------
  function toot(d) {
    if (!sounds()) return;
    try { ctx ||= new AudioContext(); if (ctx.state !== 'running') return; } catch { return; }
    const vol = 0.05 * Math.max(0, 1 - d / 70); if (vol <= 0.001) return;
    for (const [freq, t0, dur] of [[440, 0, 0.14], [370, 0.2, 0.26]]) {
      const o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + t0;
      o.type = 'square'; o.frequency.value = freq; g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(vol, at + 0.01); g.gain.setValueAtTime(vol, at + dur - 0.03); g.gain.linearRampToValueAtTime(0, at + dur);
      o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + dur + 0.05);
    }
  }

  // is one of the known players in this car's way? (within the car's length and a lane's width ahead)
  function blockedBy(a, me) {
    const p = a.pos;
    const inWay = (x, z, inCar) => {
      const rx = x - p.x, rz = z - p.z; if (rx * rx + rz * rz > 1600) return false;   // 40 m
      const ahead = rx * p.dx + rz * p.dz, lat = Math.abs(-rx * p.dz + rz * p.dx);
      // a car anywhere alongside or ahead (it never drives through one); a person on the kerb is not in the way
      return inCar ? ahead > -HL - 2 && ahead < HL + AHEAD_CAR + HL && lat < 3.2 : ahead > -HL && ahead < HL + AHEAD && lat < 1.5;
    };
    if (!me.fly && inWay(me.x, me.z, me.inCar)) return true;
    for (const o of others()) if (inWay(o.x, o.z, o.inCar)) return true;
    return false;
  }

  function update(dt, me) {
    if (!graph) return;
    const active = fleet.update(dt, me.x, me.z);
    for (let i = 0; i < fleet.slots; i++) {
      const a = active[i]; let s = slots[i];
      if (!s) { if (!a || !models.length) continue; s = slot(); if (!s) return; }
      if (s.agent !== a) { if (s.agent) hide(s); if (a) show(s, a); }
      if (!a) continue;
      const p = a.pos;
      // politeness: wait for anyone in the way, then make up the lost time; a toot after a while
      const wait = blockedBy(a, me);
      a.lag = catchUp(a.lag, dt, wait);
      if (wait) { if ((a.wait += dt) > HORN_AFTER) { toot(a.d); a.wait -= HORN_AGAIN; } } else a.wait = 0;
      // place it: the time table's point, facing along the loop (turned smoothly at corners)
      const h = Math.atan2(-p.dz * f0, p.dx * f0);
      s.yaw += wrap(h - s.yaw) * Math.min(1, dt * 8);
      const far = a.d > LOD, g = far ? s.lo : s.hi, other = far ? s.hi : s.lo;
      if (other.visible) other.visible = false;
      g.visible = true; g.position.x = p.x; g.position.z = p.z; g.rotation.y = s.yaw;
      s.fp.x = p.x; s.fp.z = p.z; s.fp.yaw = s.yaw;
    }
  }
  return {
    update,
    setCount: n => { fleet.setCount(n); for (let i = n; i < slots.length; i++) if (slots[i].agent) hide(slots[i]); },
    setNight: k => { night = k; for (const s of slots) for (const l of s.lights) l.visible = k > 0.3; },
    near: r => fleet.near(r),
    bumped(x, z) { for (const a of fleet.active) if (a && Math.hypot(a.pos.x - x, a.pos.z - z) < 6) { a.wait = HORN_AFTER + 0.01; toot(a.d); break; } },   // you drove into one: a toot
    get count() { return fleet.count; },
    get active() { return fleet.active; },   // for tests and tools: { id, pos: { x, z, v, s }, d, lag }
    get agents() { return fleet.agents; },
  };
}
