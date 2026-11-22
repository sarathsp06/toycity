// Driving: walk up to any parked car or motorbike, get in (E or the 🚗 button), drive it, get out again.
// The car you drove stays where you left it; getting into another one puts the first back in its spot.
//
// The car is a child of the player group, so streaming, the camera and multiplayer keep following
// `player` as usual; the person is hidden in a car and sits on a motorbike. Physics is a simple bicycle
// model: heading changes by speed * tan(steer) / wheelbase. Collision samples points around the body
// against the same tests walking uses (baked bitmap + the solids registry).
//
// Small consequences, never a game over:
//   - a hard crash (25 km/h or more, or another driver ramming you) turns the SUV into its wreck
//   - jump out while moving and the car rolls on by itself until it stops or hits something
//   - leave it outside a parking spot and it gets a ticket on the windscreen, and the neighbours toot
import * as THREE from 'three';
import { hits } from './solids.js';
import { STRIDE } from './parked.js';

// which end of each model (along its local x axis) is the bonnet; from the head- and taillights in cars.glb
export const FRONT = { golf: -1, camry: 1, fiat500: 1, jeep: 1, van: 1, suv: -1, suv_wreck: -1, bike: 1 };
// half length, half width and wheelbase; the car default matches the parked-car footprint in solids.js
const SIZES = { bike: { hl: 1.06, hw: 0.4, wb: 1.45 } };
const sizeOf = m => SIZES[m] || { hl: 2.15, hw: 0.88, wb: 2.6 };
export const footprintOf = (m, x, z, yaw) => { const s = sizeOf(m); return { x, z, hx: s.hl, hz: s.hw, yaw }; };
// where the driver's eyes are, in the model's own frame (x along the car, +z = its left when FRONT is -1)
// Right-hand drive (the player's choice): the driver sits on the car's right, the passenger on the left.
// The SUV model is left-hand drive, so the car you drive gets its dashboard and steering wheel mirrored.
// across: metres from the centre line to the right (+) or left (-), along the car's own z (see side()).
const EYES = { suv: [0.2, 1.22, 0.38], suv_wreck: [0.2, 1.22, 0.38], bike: [-0.35, 1.55, 0] };
// the passenger: along the car (towards the front, metres) and across (to the left), for each model
export const PASSENGER = { suv: [0.2, 0.38], suv_wreck: [0.2, 0.38], bike: [-0.6, 0] };
// local z of the car's right-hand side for a model whose bonnet points along FRONT * x
const right = model => FRONT[model] ?? 1;
// a seat as a local offset [x, z] in the car's own frame: along the length, then across (+ = right)
export function seatLocal(model, along, across) { const f = FRONT[model] ?? 1; return [along * f, across * right(model)]; }
const MAX_STEER = 0.55;
const TOP = 14, BOOST = 28, REVERSE = 5;      // m/s: 50 km/h, 100 km/h with Shift, 18 km/h backwards
const DAZED = 3, DAZED_TOP = 8;                // after a crash: 30 km/h at most for 3 s, then full speed again
const ACCEL = 5, BRAKE = 10, ROLL = 0.9;      // m/s², and how quickly a car rolls to a stop
const CRASH = 4.5;                             // m/s (16 km/h): a bump harder than this dents the car (and what it hit)
const KNOCK = 1.2;                             // m/s: faster than this, a person in the way is knocked over
const REACH = 4;                               // how close you must be to get in
const PARK_OK = 2.5;                           // within this of a parking spot counts as parked
const SNAP = 3.5;                              // stop this close to an empty spot and the vehicle is put in it
const STAND_LEAN = 0.16;                       // a parked motorbike leans on its side stand (radians)
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const TICKET_AFTER = 8, TOOT_EVERY = 14, TOOTS = 3, TOOT_NEAR = 45;
// sample points around a body as signs of (half length, half width): the four corners, then the middles
const SAMPLES = [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]];
const CORNERS = SAMPLES.slice(0, 4);
// scratch space for overlap(): the centre and four corners of each box, reused every call
const PTS_A = Array.from({ length: 5 }, () => [0, 0]), PTS_B = Array.from({ length: 5 }, () => [0, 0]);

const CABIN_TRIM = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.75, metalness: 0 });
const DRIVER_GLASS = new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.08, depthWrite: false });

// one car model as a group of meshes; the paint gets its own material (each car has its own colour).
// driven: the car you are in, built with opening doors and its interior when the model has them
// lo: the far-away version (fewer parts, no doors), for the ambient traffic beyond a hundred metres
export function makeCar(models, name, color, driven = false, lo = false) {
  const model = models.find(m => m.name === name) || models[0]; if (!model) return null;
  const g = new THREE.Group(); g.userData.car = true;
  const add = (parent, parts, cabin = false) => {
    for (const [geo, mat, role] of parts) {
      const m = new THREE.Mesh(geo, role === 'paint' ? mat.clone() : mat);
      if (role === 'paint') { m.material.color.setHex(color); m.userData.own = true; }
      // from the driver's seat the tinted glass reads as a grey film: nearly clear in the car you drive
      if (driven && /^glass/.test(mat.name)) m.material = DRIVER_GLASS;
      if (cabin && /^trim/.test(mat.name)) m.material = CABIN_TRIM;   // near-black plastic is a hole in the shade
      m.castShadow = true; parent.add(m);
    }
  };
  // a car with separate doors (see tools/blendswap_cars.py): the body plus one pivot per door, on its hinge
  if (lo) add(g, model.lo);
  else if (model.open) {
    add(g, model.open.body);
    if (driven && model.open.interior) {   // mirrored: the steering wheel goes to the right
      const cab = new THREE.Group(); cab.scale.z = -1; add(cab, model.open.interior, true); g.add(cab);
    }
    g.userData.doors = model.open.doors.map(d => {
      const pivot = new THREE.Group(); pivot.position.copy(d.hinge); add(pivot, d.parts); g.add(pivot);
      return { pivot, hinge: d.hinge };
    });
  } else add(g, model.hi);
  g.userData.model = model.name;
  return g;
}
export function disposeCar(g) {
  g?.removeFromParent();
  g?.traverse(o => { if ((o.isMesh || o.isSprite) && o.userData.own) { o.material.map?.dispose(); o.material.dispose(); } });
}

// the yellow ticket under the wiper
function ticket() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#ffd400'; x.fillRect(0, 0, 256, 128); x.strokeStyle = '#1b1206'; x.lineWidth = 6; x.strokeRect(3, 3, 250, 122);
  x.fillStyle = '#1b1206'; x.font = 'bold 40px system-ui, sans-serif'; x.textAlign = 'center';
  x.fillText('BON €95', 128, 58); x.font = '24px system-ui, sans-serif'; x.fillText('fout geparkeerd', 128, 98);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex })); s.scale.set(0.7, 0.35, 1); s.userData.own = true;
  return s;
}

// parked: the parked cars (parked.js), which also keeps which are taken (someone drives them) or dented
export function createDriving({ scene, player, models, parked, solids, ground, note = () => {}, onHitPerson = () => {}, onBumpCar = null }) {
  const { taken, dented } = parked;
  const st = { car: null, origin: null, speed: 0, steer: 0, heading: 0, model: null, color: 0 };
  let left = null;           // the car you got out of: { mesh, x, z, heading, model, color, origin, speed, ... }
  // parked cars someone crashed into (parked.dented): key -> their wrecked mesh, standing in for the instance.
  // The mesh is null while that square is unloaded (the key stays, so the spot is still dented when it comes back)
  let lost = 0;              // how many of those wait for their square to reload
  const knocked = new Map(); // person id -> seconds until they count as solid again
  let engine = null, ctx = null;
  let door = null;          // the driver's door swinging open and shut: { pivot, angle, t }
  let ignoreLeft = false;   // while the left car moves itself, it must not collide with its own footprint

  // ---------- sounds, made in the browser ----------
  const audio = () => { try { ctx ||= new AudioContext(); ctx.resume(); return ctx; } catch { return null; } };
  function beep(freq, t0, dur, gain = 0.05, type = 'square') {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(), at = a.currentTime + t0;
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.01); g.gain.setValueAtTime(gain, at + dur - 0.03); g.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(g).connect(a.destination); o.start(at); o.stop(at + dur + 0.05);
  }
  const toot = () => { beep(392, 0, 0.16, 0.035); beep(330, 0.22, 0.28, 0.035); };   // a polite double toot
  const f0 = () => FRONT[st.model] ?? 1;
  // a dull thump: someone bounced off the bonnet
  function thud() {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(140, a.currentTime); o.frequency.exponentialRampToValueAtTime(45, a.currentTime + 0.25);
    g.gain.setValueAtTime(0.35, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.3);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.35);
  }
  function crunch() {
    const a = audio(); if (!a) return;
    const n = a.createBufferSource(), buf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const f = a.createBiquadFilter(), g = a.createGain(); f.type = 'lowpass'; f.frequency.value = 900; g.gain.value = 0.25;
    n.buffer = buf; n.connect(f).connect(g).connect(a.destination); n.start();
  }

  // the driver's door: the front door on the car's left (Dutch cars). The car points along FRONT * x, so its
  // left is -FRONT * z; a door hinges at its front edge and swings its back edge outwards.
  function swing(car) {
    const doors = car?.userData.doors; if (!doors?.length) return;
    const f = FRONT[car.userData.model] ?? 1;
    const d = doors.filter(d => d.hinge.z * f > 0).sort((a, b) => b.hinge.x * f - a.hinge.x * f)[0];   // front right
    if (!d) return;
    if (door && door.pivot !== d.pivot) door.pivot.rotation.y = 0;
    door = { pivot: d.pivot, angle: Math.sign(d.hinge.z) * f * 1.15, t: 0 };
  }
  const OPEN_T = 0.35, HOLD_T = 0.55;
  const ease = k => k * k * (3 - 2 * k);

  // ---------- parked cars ----------
  // the car you got out of wins a tie; otherwise the nearest parked one that is still there
  function nearest(p) {
    let best = null, bd = REACH;
    if (left) { const d = Math.hypot(left.x - p.x, left.z - p.z); if (d < bd) { bd = d; best = { left: true }; } }
    return parked.nearest(p.x, p.z, bd) || best;
  }
  // collision: how many of 8 points around the body (corners and middles, slightly inside) touch something.
  // ghost (the autopilot): only buildings, water and hedges count; parked cars and people are driven through
  let ghost = false;
  // the moving things (other players, their cars) near the car, taken once per frame: hitsAt tests every
  // sample point against this list instead of asking every live source again for each point
  let live = [];
  function snapshot(x, z) { live = solids.liveNear(x, z, 8); if (live.length && solids.ignore.size) live = live.filter(f => !(f.id && solids.ignore.has(f.id))); return live; }
  // the count is static hits (ground, buildings, parked cars) + 100 x live hits (moving cars, people),
  // so a caller can tell the two apart: see update() for why
  let liveHits = 0;
  function hitsAt(x, z, h, model) {
    const { hl, hw } = sizeOf(model), c = Math.cos(h), s = Math.sin(h);
    let n = 0, l = 0;
    for (const [a, b] of SAMPLES) {
      const lx = a * (hl - 0.15), lz = b * (hw - 0.1);
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      if (ground(wx, wz) || (!ghost && solids.at(wx, wz, 0.05).length)) n++;
      else if (!ghost && live.some(f => hits(f, wx, wz, 0.05))) l++;
    }
    liveHits = l;
    return n + 100 * l;
  }
  // turn a car into its wreck (only models that have one, so far the SUV)
  function wreckOf(model) { return models.some(m => m.name === model + '_wreck') ? model + '_wreck' : null; }
  function wreckDriven() {
    const w = wreckOf(st.model); if (!w) return;
    disposeCar(st.car); door = null;
    st.car = makeCar(models, w, st.color, true); st.car.position.y = -0.15; player.add(st.car);
    st.model = w; st.dazed = DAZED; crunch(); note('💥 Crash! That will leave a mark.');
  }
  // a parked car you drove into: hide its instance and put its wreck in its place (it stays solid)
  function dentParked(tile, k) {
    const key = parked.key(tile, k); if (dented.has(key) || taken.has(key)) return;
    const model = parked.modelAt(tile, k), w = model && wreckOf(model.name); if (!w) return;
    const at = parked.spot(tile, k), mesh = makeCar(models, w, at.color);
    mesh.position.set(at.x, 0, at.z); mesh.rotation.y = at.yaw;
    scene.add(mesh); dented.set(key, mesh);
  }
  // a square unloads (city.js disposeTile): its wrecks go, their keys stay so the spots are still dented
  function release(tile) {
    for (const [key, mesh] of dented) if (mesh && parked.inSquare(key, tile)) { disposeCar(mesh); dented.set(key, null); lost++; }
  }
  // ...and when it is back, the wrecks are put back in their spots
  function restore() {
    for (const [key, mesh] of dented) {
      if (mesh) continue;
      const at = parked.at(key); if (at) { dented.delete(key); lost--; dentParked(at.tile, at.k); }
    }
  }
  // which parked cars a box at x, z (heading h) touches, as [tile, k]
  function parkedAt(x, z, h, model) {
    const out = [], me = footprintOf(model, x, z, h);
    for (const t of parked.tiles) {
      if (!t.carFps) continue;
      t.carFps.forEach((f, n) => { if (!f.off && Math.hypot(f.x - x, f.z - z) < 7 && overlap(f, me)) out.push([t, n * STRIDE]); });
    }
    return out;
  }
  function wreckLeft() {
    const w = wreckOf(left.model); if (!w) return;
    disposeCar(left.mesh); left.model = w;
    left.mesh = makeCar(models, w, left.color); left.mesh.position.set(left.x, 0, left.z); left.mesh.rotation.y = left.heading; scene.add(left.mesh);
    crunch();
  }

  function enter(target) {
    if (st.car) return;
    let x, z, heading, name, color, origin;
    if (target.left) { ({ x, z, heading, model: name, color, origin } = left); disposeCar(left.mesh); left = null; }
    else {
      if (left) {   // that car goes home, dents and all
        const home = left.origin, w = left.model.endsWith('_wreck');
        parked.setTaken(home, false); disposeCar(left.mesh); left = null;
        const at = w && parked.at(home); if (at) dentParked(at.tile, at.k);
      }
      origin = parked.key(target.tile, target.k); parked.setTaken(origin, true);
      x = target.x; z = target.z; heading = target.yaw; name = target.model.name; color = target.color;
      if (dented.has(origin)) { dented.get(origin).removeFromParent(); disposeCar(dented.get(origin)); dented.delete(origin); name = wreckOf(name) || name; }
    }
    const car = makeCar(models, name, color, true); car.position.y = -0.15;
    swing(car);
    player.add(car); player.position.x = x; player.position.z = z; player.rotation.y = heading;
    Object.assign(st, { car, origin, speed: 0, steer: 0, heading, model: name, color });
    startEngine();
  }
  // get out on the driver's side if there is room, else the other side, behind or in front.
  // Still moving? Then the car carries on without you.
  function exit() {
    if (!st.car) return null;
    const { heading: h } = st, f = FRONT[st.model] ?? 1, fx = Math.cos(h) * f, fz = -Math.sin(h) * f;
    const x = player.position.x, z = player.position.z;
    const rolling = Math.abs(st.speed) > 1.5;
    player.remove(st.car);
    const mesh = makeCar(models, st.model, st.color);   // the parked look: no interior
    disposeCar(st.car);
    // stopped next to an empty parking spot: the vehicle is put in it neatly, the way you would, facing
    // whichever way along the bay is nearest to how you came in
    let [px, pz, ph] = [x, z, h];
    if (!rolling) { const sp = parked.emptySpotNear(x, z, SNAP); if (sp) { px = sp.x; pz = sp.z; ph = Math.abs(wrap(sp.yaw - h)) < Math.PI / 2 ? sp.yaw : sp.yaw + Math.PI; } }
    mesh.position.set(px, 0, pz); mesh.rotation.y = ph; scene.add(mesh);
    if (st.model === 'bike') { mesh.rotation.order = 'YXZ'; mesh.rotation.x = STAND_LEAN; }   // on its side stand: turned to its heading first, then leaned about its own length
    left = { mesh, x: px, z: pz, heading: ph, model: st.model, color: st.color, origin: st.origin, speed: rolling ? st.speed : 0, t: 0, toots: 0, ticket: null };
    swing(mesh); st.car = null; stopEngine();
    if (rolling) note('🏃 You jumped out. The handbrake was not on…');
    const out = sizeOf(left.model).hw + 1.3;
    for (const [dx, dz] of [[-fz, fx], [fz, -fx], [-fx, -fz], [fx, fz]]) {   // the driver's (right) side first
      const ex = x + dx * out, ez = z + dz * out;
      if (!ground(ex, ez) && !solids.hit(ex, ez, 0.35)) return { x: ex, z: ez };
    }
    return { x: x + fz * out, z: z - fx * out };
  }
  solids.live(() => (left && !st.car && !ignoreLeft ? [footprintOf(left.model, left.x, left.z, left.heading)] : []));

  // ---------- every frame ----------
  function tick(dt, me) {
    for (const [id, t] of knocked) if (t - dt <= 0) { knocked.delete(id); solids.ignore.delete(id); } else knocked.set(id, t - dt);
    if (door) {
      const t = (door.t += dt);
      const k = t < OPEN_T ? ease(t / OPEN_T) : t < OPEN_T + HOLD_T ? 1 : 1 - ease(Math.min(1, (t - OPEN_T - HOLD_T) / OPEN_T));
      door.pivot.rotation.y = door.angle * k;
      if (t >= 2 * OPEN_T + HOLD_T) { door.pivot.rotation.y = 0; door = null; }
    }
    if (lost) restore();
    // rammed by another player's car: theirs arrives as a live footprint with its speed
    if (st.car && !st.model.endsWith('_wreck') && snapshot(player.position.x, player.position.z).length) {
      const mine = footprintOf(st.model, player.position.x, player.position.z, st.heading);
      for (const f of live) if ((f.v || 0) > CRASH && overlap(f, mine)) { wreckDriven(); break; }
    }
    if (!left) return;
    // a car left rolling coasts to a stop
    if (left.speed) {
      const f = FRONT[left.model] ?? 1, d = left.speed * dt;
      const x = left.x + Math.cos(left.heading) * f * d, z = left.z - Math.sin(left.heading) * f * d;
      ignoreLeft = true; snapshot(left.x, left.z);
      const hit = hitsAt(x, z, left.heading, left.model) > hitsAt(left.x, left.z, left.heading, left.model); ignoreLeft = false;
      if (hit) { if (Math.abs(left.speed) > CRASH) wreckLeft(); left.speed = 0; }
      else {
        left.x = x; left.z = z; left.mesh.position.set(x, 0, z);
        left.speed -= Math.sign(left.speed) * Math.min(Math.abs(left.speed), 1.6 * dt);
      }
      if (!left.speed) left.t = 0;
      return;
    }
    // parked outside a spot: a ticket after a few seconds, then a few toots while you are near
    if (st.car) return;
    left.t += dt;
    if (left.bad === undefined) left.bad = parked.toSpot(left.x, left.z) > PARK_OK;
    if (!left.bad) return;
    if (!left.ticket && left.t > TICKET_AFTER) {
      const f = FRONT[left.model] ?? 1, s = sizeOf(left.model);
      left.ticket = ticket(); left.ticket.position.set(f * s.hl * 0.35, s.hl > 1.5 ? 1.45 : 1.1, 0);
      left.mesh.add(left.ticket); note('🅿️ Parking ticket: €95. Not a parking spot!');
    }
    const near = me && Math.hypot(me.x - left.x, me.z - left.z) < TOOT_NEAR;
    if (left.ticket && near && left.toots < TOOTS && left.t > TICKET_AFTER + 2 + left.toots * TOOT_EVERY) { left.toots++; toot(); }
  }
  // two turned boxes overlap if each one's corners or centre are inside the other (good enough for cars)
  function overlap(a, b) {
    const inside = (p, q) => {
      const c = Math.cos(q.yaw), s = Math.sin(q.yaw), dx = p[0] - q.x, dz = p[1] - q.z;
      return Math.abs(dx * c - dz * s) < q.hx && Math.abs(dx * s + dz * c) < q.hz;
    };
    const pts = (f, out) => { const c = Math.cos(f.yaw), s = Math.sin(f.yaw); out[0][0] = f.x; out[0][1] = f.z;
      CORNERS.forEach(([a, b], i) => { out[i + 1][0] = f.x + a * f.hx * c + b * f.hz * s; out[i + 1][1] = f.z - a * f.hx * s + b * f.hz * c; });
      return out; };
    return pts(a, PTS_A).some(p => inside(p, b)) || pts(b, PTS_B).some(p => inside(p, a));
  }

  // input: throttle -1..1, steer -1 (right) .. 1 (left), boost (Shift), ghost (see hitsAt)
  function update(dt, { throttle, steer, boost, ghost: g = false }) {
    if (!st.car) return;
    ghost = g;
    const wrecked = st.model.endsWith('_wreck'), { wb } = sizeOf(st.model);
    // a wreck keeps its dents, but only limps for a moment right after the crash
    st.dazed = Math.max(0, (st.dazed || 0) - dt);
    const top = st.dazed ? DAZED_TOP : boost ? BOOST : TOP;
    if (throttle > 0) st.speed = st.speed < 0 ? Math.min(0, st.speed + BRAKE * dt) : Math.min(top, st.speed + ACCEL * throttle * dt);
    else if (throttle < 0) st.speed = st.speed > 0 ? Math.max(0, st.speed - BRAKE * dt) : Math.max(-REVERSE, st.speed + ACCEL * throttle * dt);
    else st.speed -= Math.sign(st.speed) * Math.min(Math.abs(st.speed), (ROLL + 0.02 * st.speed * st.speed) * dt);
    if (st.speed > top) st.speed = Math.max(top, st.speed - BRAKE * dt);   // let go of Shift: slow down
    // less steering at speed, so the car stays drivable at 100 km/h
    const want = steer * MAX_STEER / (1 + Math.abs(st.speed) / 12);
    st.steer += (want - st.steer) * Math.min(1, dt * 6);
    const f = FRONT[st.model] ?? 1;
    const h = st.heading + st.speed * Math.tan(st.steer) / wb * dt;
    const d = st.speed * dt, x = player.position.x + Math.cos(h) * f * d, z = player.position.z - Math.sin(h) * f * d;
    // A move is fine when it touches nothing, or touches less than now: a car parked tight against its
    // neighbour starts out touching it and may always back away. Otherwise bump: bounce back a little.
    // a person in the way: faster than walking pace they are knocked flying, and the car carries on
    if (snapshot(x, z).length && !ghost && Math.abs(st.speed) > KNOCK) {
      const me = footprintOf(st.model, x, z, h), fx = Math.cos(h) * f0(), fz = -Math.sin(h) * f0(); let hit = false;
      for (const f of live) {
        if (!f.id || f.hx !== undefined || knocked.has(f.id) || !overlap({ ...f, hx: f.r, hz: f.r, yaw: 0 }, me)) continue;
        knocked.set(f.id, 3); solids.ignore.add(f.id); hit = true;
        st.speed *= 0.8; thud();
        onHitPerson(f.id, fx * st.speed, fz * st.speed);
      }
      if (hit) live = live.filter(f => !(f.id && knocked.has(f.id)));   // they are no longer in the way
    }
    // A move is fine when it touches nothing, or touches less than now. Moving cars and people are a
    // special case: driving into one is a bump, but once you are touching one (it drove into you, or
    // you into it) any move is allowed, so you can always back out and never get wedged inside it.
    const now = hitsAt(player.position.x, player.position.z, st.heading, st.model), nowL = liveHits, next = hitsAt(x, z, h, st.model), nextL = liveHits;
    const nowS = now - 100 * nowL, nextS = next - 100 * nextL;
    if ((nextS === 0 || nextS < nowS) && (nextL === 0 || nowL > 0)) { player.position.x = x; player.position.z = z; st.heading = h; }
    else {
      const impact = Math.abs(st.speed);
      st.speed *= -0.25;
      if (impact > CRASH && !ghost) {
        if (!wrecked) wreckDriven();
        for (const [t, k] of parkedAt(x, z, h, st.model)) dentParked(t, k);   // the car you hit takes a dent too
      }
      // arcade help for tight spots: blocked, you can still turn a little on the spot to wiggle out
      const turn = st.heading + steer * 0.6 * dt;
      if (steer && hitsAt(player.position.x, player.position.z, turn, st.model) <= now) st.heading = turn;
      if (nextL > nowL && impact > KNOCK) onBumpCar?.(x, z);   // you ran into a moving car: it minds
    }
    player.rotation.y = st.heading; ghost = false;
    // a motorbike leans into the turn
    if (st.model === 'bike') st.car.rotation.x = THREE.MathUtils.clamp(-st.speed * Math.tan(st.steer) * 0.12, -0.5, 0.5) * f;
    if (engine) {
      const s = Math.abs(st.speed), gear = s % 7 / 7;   // pitch climbs within each "gear"
      const base = st.model === 'bike' ? 70 : 38;
      engine.osc.frequency.setTargetAtTime(base + s * 2.2 + gear * 30, engine.ctx.currentTime, 0.1);
      // heard only when you start or press the accelerator; cruising and standing still are quiet
      const on = throttle !== 0 && (Math.sign(throttle) === Math.sign(st.speed) || Math.abs(st.speed) < 0.5);
      engine.gain.gain.setTargetAtTime(on ? 0.03 + Math.min(0.03, s * 0.001) : 0, engine.ctx.currentTime, on ? 0.08 : 0.35);
    }
  }
  // a soft engine hum: a sawtooth through a low-pass filter
  function startEngine() {
    const a = audio(); if (!a) { engine = null; return; }
    const osc = a.createOscillator(), filt = a.createBiquadFilter(), gain = a.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = 38; filt.type = 'lowpass'; filt.frequency.value = 380; gain.gain.value = 0;
    osc.connect(filt).connect(gain).connect(a.destination); osc.start();
    gain.gain.setTargetAtTime(0.04, a.currentTime, 0.05);          // a short start-up rev, then quiet
    osc.frequency.setValueAtTime(38, a.currentTime); osc.frequency.linearRampToValueAtTime(75, a.currentTime + 0.35);
    osc.frequency.linearRampToValueAtTime(42, a.currentTime + 0.8);
    gain.gain.setTargetAtTime(0, a.currentTime + 0.7, 0.25);
    engine = { ctx: a, osc, gain };
  }
  function stopEngine() {
    if (!engine) return;
    const { ctx: a, osc, gain } = engine; gain.gain.setTargetAtTime(0, a.currentTime, 0.15); setTimeout(() => osc.stop(), 600);
    engine = null;
  }

  // put the car you drive at x, z facing the point tx, tz (the autopilot's last resort when it is stuck)
  function place(x, z, tx, tz) {
    if (!st.car) return;
    const f = FRONT[st.model] ?? 1, a = Math.atan2(-(tz - z), tx - x);
    player.position.x = x; player.position.z = z; st.heading = f > 0 ? a : a - Math.PI; st.speed = 0;
    player.rotation.y = st.heading;
  }

  return {
    nearest, enter, exit, update, tick, taken, place, dented, release,
    get left() { return left; },   // the vehicle you got out of (tests)
    get heading() { return st.heading; }, set heading(h) { st.heading = h; player.rotation.y = h; },   // (tests)
    get driving() { return !!st.car; },
    get speed() { return st.speed; },
    get model() { return st.model; },
    // on a motorbike you see the rider; in a car you don't
    get rider() { return !!st.car && st.model === 'bike'; },
    // forward direction of the car, for the camera
    get forward() { const f = FRONT[st.model] ?? 1; return [Math.cos(st.heading) * f, -Math.sin(st.heading) * f]; },
    // the driver's eyes in world space, for the first-person view
    eyes(out) {
      const [ex, ey, ez] = EYES[st.model] || [0, 1.3, 0.4];
      const [lx, lz] = seatLocal(st.model, ex, ez), c = Math.cos(st.heading), s = Math.sin(st.heading);
      return out.set(player.position.x + lx * c + lz * s, ey, player.position.z - lx * s + lz * c);
    },
    // what other players need to draw my car: "model:colour", empty when on foot
    get shared() { return st.car ? st.model + ':' + st.color.toString(16) : ''; },
  };
}
