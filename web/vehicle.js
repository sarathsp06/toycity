// Driving: walk up to any parked car, get in (E or the 🚗 button), drive it, get out again.
// The car you drove stays where you left it; getting into another one puts the first back in its spot.
//
// The car is a child of the player group, so streaming, the camera and multiplayer keep following
// `player` as usual; the person is hidden while driving. Physics is a simple bicycle model:
// heading changes by speed * tan(steer) / wheelbase. Collision samples points around the car body
// against the same tests walking uses (baked bitmap + the solids registry).
import * as THREE from 'three';

// which end of each model (along its local x axis) is the bonnet; from the head- and taillights in cars.glb
export const FRONT = { golf: -1, camry: 1, fiat500: 1, jeep: 1, van: 1 };
const HALF_L = 2.15, HALF_W = 0.88;           // the parked-car footprint in solids.js
const WHEELBASE = 2.6, MAX_STEER = 0.55;
const TOP = 14, BOOST = 28, REVERSE = 5;      // m/s: 50 km/h, 100 km/h with Shift, 18 km/h backwards
const ACCEL = 5, BRAKE = 10, ROLL = 0.9;      // m/s², and how quickly a car rolls to a stop
export const REACH = 4;                        // how close you must be to get in

// one car model as a group of meshes; the paint gets its own material (each car has its own colour)
export function makeCar(models, name, color) {
  const model = models.find(m => m.name === name) || models[0]; if (!model) return null;
  const g = new THREE.Group(); g.userData.car = true;
  for (const [geo, mat, role] of model.hi) {
    const m = new THREE.Mesh(geo, role === 'paint' ? mat.clone() : mat);
    if (role === 'paint') { m.material.color.setHex(color); m.userData.own = true; }
    m.castShadow = true; g.add(m);
  }
  return g;
}
export function disposeCar(g) { g?.removeFromParent(); g?.traverse(o => { if (o.isMesh && o.userData.own) o.material.dispose(); }); }

// parked cars are keyed by square and index, so a taken car stays taken when its square reloads
export const carKey = (tile, k) => tile.i + '_' + tile.j + ':' + k;

export function createDriving({ scene, player, models, carTiles, solids, ground }) {
  const taken = new Set();
  const st = { car: null, origin: null, speed: 0, steer: 0, heading: 0, model: null, color: 0 };
  let left = null;          // the car you got out of: { mesh, x, z, heading, model, color, origin }
  let engine = null;

  // parked car within reach (the free one you left behind counts too)
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
  function setTaken(key, on, tiles) {
    on ? taken.add(key) : taken.delete(key);
    for (const t of tiles) if (t.carFps && key.startsWith(t.i + '_' + t.j + ':')) { const f = t.carFps[+key.split(':')[1] / 6]; if (f) f.off = on; }
  }
  const footprint = (x, z, h) => ({ x, z, hx: HALF_L, hz: HALF_W, yaw: h });
  // collision: how many of 8 points around the body (corners and middles, slightly inside) touch something
  function hitsAt(x, z, h) {
    const c = Math.cos(h), s = Math.sin(h);
    let n = 0;
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const lx = a * (HALF_L - 0.15), lz = b * (HALF_W - 0.1);
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      if (ground(wx, wz) || solids.hit(wx, wz, 0.05)) n++;
    }
    return n;
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
    const car = makeCar(models, name, color); car.position.y = -0.15;
    player.add(car); player.position.x = x; player.position.z = z; player.rotation.y = heading;
    Object.assign(st, { car, origin, speed: 0, steer: 0, heading, model: name, color });
    startEngine();
  }
  // get out on the driver's side if there is room, else the other side, behind or in front
  function exit() {
    if (!st.car) return null;
    const { heading: h } = st, f = FRONT[st.model] ?? 1, fx = Math.cos(h) * f, fz = -Math.sin(h) * f;
    const x = player.position.x, z = player.position.z;
    left = { mesh: st.car, x, z, heading: h, model: st.model, color: st.color, origin: st.origin };
    player.remove(st.car); st.car.position.set(x, 0, z); st.car.rotation.y = h; scene.add(st.car);
    st.car = null; stopEngine();
    for (const [dx, dz] of [[fz, -fx], [-fz, fx], [-fx, -fz], [fx, fz]]) {
      const ex = x + dx * 2.2, ez = z + dz * 2.2;
      if (!ground(ex, ez) && !solids.hit(ex, ez, 0.35)) return { x: ex, z: ez };
    }
    return { x: x + fz * 2.2, z: z - fx * 2.2 };
  }
  solids.live(() => (left && !st.car ? [footprint(left.x, left.z, left.heading)] : []));

  // input: throttle -1..1, steer -1 (right) .. 1 (left), boost (Shift)
  function update(dt, { throttle, steer, boost }) {
    if (!st.car) return;
    const top = boost ? BOOST : TOP;
    if (throttle > 0) st.speed = st.speed < 0 ? Math.min(0, st.speed + BRAKE * dt) : Math.min(top, st.speed + ACCEL * throttle * dt);
    else if (throttle < 0) st.speed = st.speed > 0 ? Math.max(0, st.speed - BRAKE * dt) : Math.max(-REVERSE, st.speed + ACCEL * throttle * dt);
    else st.speed -= Math.sign(st.speed) * Math.min(Math.abs(st.speed), (ROLL + 0.02 * st.speed * st.speed) * dt);
    if (st.speed > top) st.speed = Math.max(top, st.speed - BRAKE * dt);   // let go of Shift: slow down
    // less steering at speed, so the car stays drivable at 100 km/h
    const want = steer * MAX_STEER / (1 + Math.abs(st.speed) / 12);
    st.steer += (want - st.steer) * Math.min(1, dt * 6);
    const f = FRONT[st.model] ?? 1;
    const h = st.heading + st.speed * Math.tan(st.steer) / WHEELBASE * dt;
    const d = st.speed * dt, x = player.position.x + Math.cos(h) * f * d, z = player.position.z - Math.sin(h) * f * d;
    // A move is fine when it touches nothing, or touches less than now: a car parked tight against its
    // neighbour starts out touching it and may always back away. Otherwise bump: bounce back a little.
    const now = hitsAt(player.position.x, player.position.z, st.heading), next = hitsAt(x, z, h);
    if (next === 0 || next < now) { player.position.x = x; player.position.z = z; st.heading = h; }
    else {
      st.speed *= -0.25;
      // arcade help for tight spots: blocked, you can still turn a little on the spot to wiggle out
      const turn = st.heading + steer * 0.6 * dt;
      if (steer && hitsAt(player.position.x, player.position.z, turn) <= now) st.heading = turn;
    }
    player.rotation.y = st.heading;
    if (engine) {
      const s = Math.abs(st.speed), gear = s % 7 / 7;   // pitch climbs within each "gear"
      engine.osc.frequency.setTargetAtTime(38 + s * 2.2 + gear * 30, engine.ctx.currentTime, 0.1);
      engine.gain.gain.setTargetAtTime(0.035 + Math.min(0.04, Math.abs(throttle) * 0.03 + s * 0.001), engine.ctx.currentTime, 0.1);
    }
  }
  // a soft engine hum made in the browser: a sawtooth through a low-pass filter
  function startEngine() {
    try {
      const ctx = engine?.ctx || new AudioContext(), osc = ctx.createOscillator(), filt = ctx.createBiquadFilter(), gain = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = 38; filt.type = 'lowpass'; filt.frequency.value = 380; gain.gain.value = 0;
      osc.connect(filt).connect(gain).connect(ctx.destination); osc.start(); ctx.resume();
      gain.gain.setTargetAtTime(0.035, ctx.currentTime, 0.2);
      engine = { ctx, osc, gain };
    } catch { engine = null; }
  }
  function stopEngine() {
    if (!engine) return;
    const { ctx, osc, gain } = engine; gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15); setTimeout(() => osc.stop(), 600);
    engine = { ctx };
  }

  return {
    nearest, enter, exit, update, taken,
    get driving() { return !!st.car; },
    get speed() { return st.speed; },
    // forward direction of the car, for the camera
    get forward() { const f = FRONT[st.model] ?? 1; return [Math.cos(st.heading) * f, -Math.sin(st.heading) * f]; },
    // what other players need to draw my car: "model:colour", empty when on foot
    get shared() { return st.car ? st.model + ':' + st.color.toString(16) : ''; },
  };
}
