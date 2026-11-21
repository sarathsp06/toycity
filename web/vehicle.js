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

// which end of each model (along its local x axis) is the bonnet; from the head- and taillights in cars.glb
export const FRONT = { golf: -1, camry: 1, fiat500: 1, jeep: 1, van: 1, suv: -1, suv_wreck: -1, bike: 1 };
// half length, half width and wheelbase; the car default matches the parked-car footprint in solids.js
const SIZES = { bike: { hl: 1.06, hw: 0.4, wb: 1.45 } };
const sizeOf = m => SIZES[m] || { hl: 2.15, hw: 0.88, wb: 2.6 };
export const footprintOf = (m, x, z, yaw) => { const s = sizeOf(m); return { x, z, hx: s.hl, hz: s.hw, yaw }; };
// where the driver's eyes are, in the model's own frame (x along the car, +z = its left when FRONT is -1)
const EYES = { suv: [0.2, 1.22, 0.38], suv_wreck: [0.2, 1.22, 0.38], bike: [-0.35, 1.55, 0] };
const MAX_STEER = 0.55;
const TOP = 14, BOOST = 28, REVERSE = 5;      // m/s: 50 km/h, 100 km/h with Shift, 18 km/h backwards
const DAZED = 3, DAZED_TOP = 8;                // after a crash: 30 km/h at most for 3 s, then full speed again
const ACCEL = 5, BRAKE = 10, ROLL = 0.9;      // m/s², and how quickly a car rolls to a stop
const CRASH = 7;                               // m/s (25 km/h): a bump harder than this wrecks the car
export const REACH = 4;                        // how close you must be to get in
const PARK_OK = 2.5;                           // within this of a parking spot counts as parked
const TICKET_AFTER = 8, TOOT_EVERY = 14, TOOTS = 3, TOOT_NEAR = 45;

const CABIN_TRIM = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.75, metalness: 0 });
const DRIVER_GLASS = new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.08, depthWrite: false });

// one car model as a group of meshes; the paint gets its own material (each car has its own colour).
// driven: the car you are in, built with opening doors and its interior when the model has them
export function makeCar(models, name, color, driven = false) {
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
  if (model.open) {
    add(g, model.open.body);
    if (driven && model.open.interior) add(g, model.open.interior, true);
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

// parked cars are keyed by square and index, so a taken car stays taken when its square reloads
export const carKey = (tile, k) => tile.i + '_' + tile.j + ':' + k;

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

export function createDriving({ scene, player, models, carTiles, solids, ground, note = () => {} }) {
  const taken = new Set();
  const st = { car: null, origin: null, speed: 0, steer: 0, heading: 0, model: null, color: 0 };
  let left = null;          // the car you got out of: { mesh, x, z, heading, model, color, origin, speed, ... }
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
    const d = doors.filter(d => d.hinge.z * -f > 0).sort((a, b) => b.hinge.x * f - a.hinge.x * f)[0];
    if (!d) return;
    if (door && door.pivot !== d.pivot) door.pivot.rotation.y = 0;
    door = { pivot: d.pivot, angle: Math.sign(d.hinge.z) * f * 1.15, t: 0 };
  }
  const OPEN_T = 0.35, HOLD_T = 0.55;
  const ease = k => k * k * (3 - 2 * k);

  // ---------- parked cars ----------
  function nearest(p) {
    let best = null, bd = REACH;
    if (left) { const d = Math.hypot(left.x - p.x, left.z - p.z); if (d < bd) { bd = d; best = { left: true }; } }
    for (const tile of carTiles) {
      const { data, all } = tile.cars, ox = tile.group.position.x, oz = tile.group.position.z;
      for (const { k, model } of all) {
        if (taken.has(carKey(tile, k))) continue;
        const d = Math.hypot(data[k] + ox - p.x, data[k + 2] + oz - p.z);
        if (d < bd) { bd = d; best = { tile, k, model, x: data[k] + ox, z: data[k + 2] + oz, yaw: data[k + 3], color: data[k + 5] }; }
      }
    }
    return best;
  }
  // distance to the nearest parking spot (taken ones count: that is where you took it from)
  function toSpot(x, z) {
    let bd = Infinity;
    for (const tile of carTiles) {
      const { data } = tile.cars, ox = tile.group.position.x, oz = tile.group.position.z;
      for (let k = 0; k < data.length; k += 6) bd = Math.min(bd, Math.hypot(data[k] + ox - x, data[k + 2] + oz - z));
    }
    return bd;
  }
  function setTaken(key, on, tiles) {
    on ? taken.add(key) : taken.delete(key);
    for (const t of tiles) if (t.carFps && key.startsWith(t.i + '_' + t.j + ':')) { const f = t.carFps[+key.split(':')[1] / 6]; if (f) f.off = on; }
  }
  // collision: how many of 8 points around the body (corners and middles, slightly inside) touch something.
  // ghost (the autopilot): only buildings, water and hedges count; parked cars and people are driven through
  let ghost = false;
  function hitsAt(x, z, h, model) {
    const { hl, hw } = sizeOf(model), c = Math.cos(h), s = Math.sin(h);
    let n = 0;
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const lx = a * (hl - 0.15), lz = b * (hw - 0.1);
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      if (ground(wx, wz) || (!ghost && solids.hit(wx, wz, 0.05))) n++;
    }
    return n;
  }
  // turn a car into its wreck (only models that have one, so far the SUV)
  function wreckOf(model) { return models.some(m => m.name === model + '_wreck') ? model + '_wreck' : null; }
  function wreckDriven() {
    const w = wreckOf(st.model); if (!w) return;
    disposeCar(st.car); door = null;
    st.car = makeCar(models, w, st.color, true); st.car.position.y = -0.15; player.add(st.car);
    st.model = w; st.dazed = DAZED; crunch(); note('💥 Crash! That will leave a mark.');
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
      if (left) { setTaken(left.origin, false, carTiles); disposeCar(left.mesh); left = null; }   // that car goes home
      origin = carKey(target.tile, target.k); setTaken(origin, true, carTiles);
      x = target.x; z = target.z; heading = target.yaw; name = target.model.name; color = target.color;
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
    mesh.position.set(x, 0, z); mesh.rotation.y = h; scene.add(mesh);
    left = { mesh, x, z, heading: h, model: st.model, color: st.color, origin: st.origin, speed: rolling ? st.speed : 0, t: 0, toots: 0, ticket: null };
    swing(mesh); st.car = null; stopEngine();
    if (rolling) note('🏃 You jumped out. The handbrake was not on…');
    const out = sizeOf(left.model).hw + 1.3;
    for (const [dx, dz] of [[fz, -fx], [-fz, fx], [-fx, -fz], [fx, fz]]) {
      const ex = x + dx * out, ez = z + dz * out;
      if (!ground(ex, ez) && !solids.hit(ex, ez, 0.35)) return { x: ex, z: ez };
    }
    return { x: x + fz * out, z: z - fx * out };
  }
  solids.live(() => (left && !st.car && !ignoreLeft ? [footprintOf(left.model, left.x, left.z, left.heading)] : []));

  // ---------- every frame ----------
  function tick(dt, me) {
    if (door) {
      const t = (door.t += dt);
      const k = t < OPEN_T ? ease(t / OPEN_T) : t < OPEN_T + HOLD_T ? 1 : 1 - ease(Math.min(1, (t - OPEN_T - HOLD_T) / OPEN_T));
      door.pivot.rotation.y = door.angle * k;
      if (t >= 2 * OPEN_T + HOLD_T) { door.pivot.rotation.y = 0; door = null; }
    }
    // rammed by another player's car: theirs arrives as a live footprint with its speed
    if (st.car && !st.model.endsWith('_wreck')) {
      const mine = footprintOf(st.model, player.position.x, player.position.z, st.heading);
      for (const f of solids.liveNear(mine.x, mine.z, 6)) if ((f.v || 0) > CRASH && overlap(f, mine)) { wreckDriven(); break; }
    }
    if (!left) return;
    // a car left rolling coasts to a stop
    if (left.speed) {
      const f = FRONT[left.model] ?? 1, d = left.speed * dt;
      const x = left.x + Math.cos(left.heading) * f * d, z = left.z - Math.sin(left.heading) * f * d;
      ignoreLeft = true; const hit = hitsAt(x, z, left.heading, left.model) > hitsAt(left.x, left.z, left.heading, left.model); ignoreLeft = false;
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
    if (left.bad === undefined) left.bad = toSpot(left.x, left.z) > PARK_OK;
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
    const pts = f => { const c = Math.cos(f.yaw), s = Math.sin(f.yaw), out = [[f.x, f.z]];
      for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) out.push([f.x + a * f.hx * c + b * f.hz * s, f.z - a * f.hx * s + b * f.hz * c]);
      return out; };
    return pts(a).some(p => inside(p, b)) || pts(b).some(p => inside(p, a));
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
    const now = hitsAt(player.position.x, player.position.z, st.heading, st.model), next = hitsAt(x, z, h, st.model);
    if (next === 0 || next < now) { player.position.x = x; player.position.z = z; st.heading = h; }
    else {
      const impact = Math.abs(st.speed);
      st.speed *= -0.25;
      if (impact > CRASH && !wrecked && !ghost) wreckDriven();
      // arcade help for tight spots: blocked, you can still turn a little on the spot to wiggle out
      const turn = st.heading + steer * 0.6 * dt;
      if (steer && hitsAt(player.position.x, player.position.z, turn, st.model) <= now) st.heading = turn;
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
    nearest, enter, exit, update, tick, taken, place,
    get driving() { return !!st.car; },
    get speed() { return st.speed; },
    get model() { return st.model; },
    // on a motorbike you see the rider; in a car you don't
    get rider() { return !!st.car && st.model === 'bike'; },
    // forward direction of the car, for the camera
    get forward() { const f = FRONT[st.model] ?? 1; return [Math.cos(st.heading) * f, -Math.sin(st.heading) * f]; },
    // the driver's eyes in world space, for the first-person view
    eyes(out) {
      const [ex, ey, ez] = EYES[st.model] || [0, 1.3, 0.4], f = FRONT[st.model] ?? 1;
      const lx = ex * f, lz = ez * -f, c = Math.cos(st.heading), s = Math.sin(st.heading);
      return out.set(player.position.x + lx * c + lz * s, ey, player.position.z - lx * s + lz * c);
    },
    // what other players need to draw my car: "model:colour", empty when on foot
    get shared() { return st.car ? st.model + ':' + st.color.toString(16) : ''; },
  };
}
