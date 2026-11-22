// Ambient life, shared by the traffic (traffic.js) and the people on the pavements (peds.js).
//
// Everyone playing shares the world peer to peer with no server, and they must all see the same cars
// and people in the same places. So nothing here is random over time: the whole simulation is a pure
// function of the wall clock.
//
//   - Every ambient car or person has a stable id: the map square it belongs to and a number,
//     "<i>_<j>:<k>". Its route is a closed loop derived from the region's road graph and that id only:
//     a PRNG seeded from region slug + square + id picks a start node in the square and a far node a few
//     hundred metres away; the existing A* (autopilot.js, local graph) plans there and back, and the two
//     legs make the loop. Every browser gets the same loop, since the graph is the same file.
//   - Along the loop a time table is built (cumulative metres S and seconds T per point) from the
//     speed limit, bends and planned pauses. Position = progress at (Date.now() / 1000 + phase(id))
//     mod loop period. Browsers agree within their clock drift.
//   - Which loops exist near me follows from which squares are within reach of the player, never from
//     a random spawn; the nearest `show` of them get a mesh (a slot from a fixed pool).
//   - Politeness is a local lag: a car waiting for the player falls behind its schedule, then catches
//     up at 1.5x. A person knocked over does the same while lying down. The lag never changes the
//     schedule, so no browser ever diverges from the others; it is dropped once the thing is out of sight.
//
// Nothing in this file touches three.js, so the unit tests (tests/ambient.test.mjs) can run it in node.

// ---------- deterministic numbers ----------
// FNV-1a over the text of all parts: the same seed on every device for the same id
export function seed(...parts) {
  let h = 2166136261;
  for (const p of parts) { const s = String(p); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= 0x9e3779b9; h = Math.imul(h, 16777619); }
  return h >>> 0 || 1;
}
// xorshift32: a tiny generator giving 0 <= x < 1
export function rng(s) {
  let x = s >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

// ---------- the road graph ----------
// may this node be driven or walked away from (it has a segment with this vehicle bit)
export const usable = (g, n, bit) => { const o = g.out[n]; for (let k = 1; k < o.length; k += 2) if (o[k] & bit) return true; return false; };
// the speed limit (km/h) of the segment u-v, whichever way it was drawn; 30 when unknown
export function limitOf(g, u, v) {
  let o = g.out[u]; for (let k = 0; k < o.length; k += 2) if (o[k] === v) return o[k + 1] >> 4;
  o = g.out[v]; for (let k = 0; k < o.length; k += 2) if (o[k] === u) return o[k + 1] >> 4;
  return 30;
}
// a usable node between min and max metres from node a, picked by r (a few tries, else -1)
export function farNode(g, a, bit, r, min, max, tries = 80, ok = () => true) {
  const N = g.xs.length;
  for (let t = 0; t < tries; t++) {
    const n = Math.floor(r() * N) % N;
    const d = Math.hypot(g.xs[n] - g.xs[a], g.zs[n] - g.zs[a]);
    if (d >= min && d <= max && usable(g, n, bit) && ok(n)) return n;
  }
  return -1;
}

// ---------- the loop ----------
// Move a closed polyline to the right-hand side (lane metres off the centre line), the same idea as
// autopilot.js lanePath but with the neighbours wrapping round: no fade at a start or an end, since a
// loop has neither. Points within `gap` metres of the previous one are dropped. Returns [[x, z], ...].
export function laneLoop(pts, lane, gap = 1) {
  const path = [];
  for (const p of pts) { const q = path[path.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > gap) path.push([p[0], p[1]]); }
  if (path.length > 1 && Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]) <= gap) path.pop();
  const n = path.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = path[(i + n - 1) % n], a = path[i], b = path[(i + 1) % n];
    let dx = b[0] - p[0], dz = b[1] - p[1]; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    const sd = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cos = sd ? Math.max(0, (dx * (b[0] - a[0]) + dz * (b[1] - a[1])) / sd) : 1;
    const o = lane * cos * cos;
    out.push([a[0] - dz * o, a[1] + dx * o]);   // right of (dx, dz) is (-dz, dx)
  }
  return out;
}
// split segments longer than `step` metres, so a bend only slows the last stretch before it
export function densify(pts, step, extra = []) {
  const out = [], ex = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) { out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); ex.push(k ? null : extra[i] ?? null); }
  }
  return { pts: out, extra: ex };
}
// how fast the loop goes through the corner at point i (closed polyline), from the turn angle:
// a gentle bend keeps the speed, a right angle drops to `slow`
export function cornerSpeed(pts, i, fast, slow) {
  const n = pts.length, p = pts[(i + n - 1) % n], a = pts[i], b = pts[(i + 1) % n];
  const a1 = Math.atan2(a[1] - p[1], a[0] - p[0]), a2 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  let d = a2 - a1; d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  return Math.max(slow, fast - (fast - slow) * Math.min(1, d / 1.2));
}
// The time table of a closed loop. pts: the points; speed(i): m/s at point i (the segment i -> i+1 runs at
// the mean of its two ends); dwell(i): seconds to stand still at point i (0 for none). Everything is
// cumulative Float64Arrays over 2n entries at most, so sampling is a binary search and no allocation.
//   { n, x, z, S, T, V, dx, dz, P, L }  P: period in seconds, L: length in metres; entry i is point i's
//   arrival (dwell entries sit between: same place, time passes)
export function timeTable(pts, speed, dwell = () => 0) {
  const n = pts.length, x = [], z = [], S = [], T = [], V = [], dx = [], dz = [];
  let s = 0, t = 0;
  const push = (p, v, ddx, ddz) => { x.push(p[0]); z.push(p[1]); S.push(s); T.push(t); V.push(v); dx.push(ddx); dz.push(ddz); };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6;
    const ddx = (b[0] - a[0]) / L, ddz = (b[1] - a[1]) / L;
    const w = dwell(i);
    if (w > 0) { push(a, 0, ddx, ddz); t += w; }   // the dwell: an entry that goes nowhere
    const v = Math.max(0.3, (speed(i) + speed((i + 1) % n)) / 2);
    push(a, v, ddx, ddz); s += L; t += L / v;
  }
  return { n: x.length, x: Float64Array.from(x), z: Float64Array.from(z), S: Float64Array.from(S), T: Float64Array.from(T), V: Float64Array.from(V), dx: Float64Array.from(dx), dz: Float64Array.from(dz), P: t, L: s };
}
// where a loop is at time t (seconds, any size): out = { x, z, dx, dz, v, s } filled in place
export function sample(tab, t, out) {
  const { T, n, P } = tab;
  let u = t % P; if (u < 0) u += P;
  let lo = 0, hi = n - 1;   // the last entry whose T <= u
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= u) lo = m; else hi = m - 1; }
  const i = lo, j = (i + 1) % n, t1 = j ? T[j] : P, span = t1 - T[i];
  const k = span > 0 ? (u - T[i]) / span : 0;
  const ax = tab.x[i], az = tab.z[i], bx = tab.x[j], bz = tab.z[j];
  out.x = ax + (bx - ax) * k; out.z = az + (bz - az) * k;
  out.dx = tab.dx[i]; out.dz = tab.dz[i]; out.v = tab.V[i]; out.s = tab.S[i] + (tab.S[j] - tab.S[i]) * k;
  return out;
}
// the local lag: waiting adds to it, afterwards it is made up at `rate` times the normal pace extra
// (0.5: moving at 1.5x), never below zero
export const catchUp = (lag, dt, waiting, rate = 0.5) => waiting ? lag + dt : Math.max(0, lag - dt * rate);

// Build a loop for one id: start node a (in its square), a far node, there and back along the graph.
//   route(a, b, bit) -> node ids or null;  lane: metres right of the centre line;  speed(limitKmh, i, pts)
//   maxLimit: never route over roads faster than this (km/h), e.g. no people along the motorway
// Returns { tab, phase } or null when no loop can be made from there.
//   the loop is at most 3 x max metres long (one-way streets can make the way back a detour)
export function buildLoop(g, { id, slug, a, bit, route, lane, min = 300, max = 800, speedAt, dwellAt, maxLimit = 999, step = 12 }) {
  const r = rng(seed(slug, id));
  for (let tries = 0; tries < 6; tries++) {
    const b = farNode(g, a, bit, r, min, max); if (b < 0) continue;
    const go = route(a, b, bit); if (!go || go.length < 3) continue;
    const back = route(b, a, bit); if (!back || back.length < 3) continue;
    let ids = go.concat(back.slice(1, -1));
    // nodes within a metre of the previous one (or of the first, at the close) are one point
    ids = ids.filter((v, i, all) => { const p = all[i ? i - 1 : all.length - 1]; return i === 0 || Math.hypot(g.xs[v] - g.xs[p], g.zs[v] - g.zs[p]) > 1; });
    if (ids.length > 1 && Math.hypot(g.xs[ids[0]] - g.xs[ids[ids.length - 1]], g.zs[ids[0]] - g.zs[ids[ids.length - 1]]) <= 1) ids.pop();
    let fast = false; const limits = [];
    for (let i = 0; i < ids.length; i++) { const l = limitOf(g, ids[i], ids[(i + 1) % ids.length]); limits.push(l); if (l > maxLimit) fast = true; }
    if (fast || ids.length < 4) continue;
    const raw = ids.map(v => [g.xs[v], g.zs[v]]);
    const { pts: dense, extra } = densify(raw, step, limits);
    // a point inherits the limit of the segment it starts (densified points too)
    let cur = limits[0]; const lim = extra.map(l => (cur = l ?? cur));
    const pts = laneLoop(dense, lane, 0);   // nothing is dropped here: lim and extra stay aligned
    if (pts.length < 4) continue;
    const tab = timeTable(pts, i => speedAt(lim[i] ?? 30, i, pts, r), i => (dwellAt ? dwellAt(i, pts, r, extra[i] !== null) : 0));
    if (!(tab.P > 1) || tab.L > 3 * max) continue;
    return { tab, phase: r() * tab.P, start: a, far: b };
  }
  return null;
}

// ---------- the fleet: which ids exist near the player, and which of them get a mesh ----------
//   nodesOf(key): the usable road nodes in map square key ("i_j"), or []
//   plan(id, startNode, r): { tab, phase } or null (one is built per update at most, so a frame never stalls)
//   per: ids per square; show: meshes at most; radius: metres (seen within, dropped beyond)
//   per: loops per square for each shown one (a loop is anywhere on its route, so only a share of them
//   are within reach at a time: more for a short reach)
export function createFleet({ slug, T, toRD, nodesOf, plan, per = 1, show, radius, hysteresis = 20 }) {
  const agents = new Map();   // id -> { id, key, k, loop, dead, lag, slot, d, pos: {x,z,dx,dz,v,s}, t }
  const cache = new Map();    // id -> loop, kept for a while after its square went out of reach
  const active = [];          // agents with a slot, in slot order (holes are null)
  // ids per square: enough for `show` shown at once across the squares in reach, with room to spare
  // (a loop is often partly out of reach), not `show` in every square: each one costs a route to plan
  const spread = Math.max(1, (2 * radius / T + 1) ** 2 / 4);
  const wantFor = n => Math.max(1, Math.ceil(n * per / spread));
  let want = wantFor(show), slots = show, tick = 0, keys = [], px = 0, pz = 0, idle = false;
  const cells = () => Math.ceil(radius / T);
  // the squares within reach of the player, nearest first
  function reach(x, z) {
    const [X, Y] = toRD(x, z), ci = Math.floor(X / T), cj = Math.floor(Y / T), c = cells(), out = [];
    for (let i = ci - c; i <= ci + c; i++) for (let j = cj - c; j <= cj + c; j++) {
      const d = Math.hypot(Math.max(i * T - X, 0, X - (i + 1) * T), Math.max(j * T - Y, 0, Y - (j + 1) * T));
      if (d <= radius) out.push([i + '_' + j, d]);
    }
    return out.sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }
  function ensure(key, k) {
    const id = key + ':' + k; let a = agents.get(id);
    if (a) return a;
    a = { id, key, k, loop: cache.get(id) || null, dead: false, lag: 0, slot: -1, d: Infinity, pos: { x: 0, z: 0, dx: 1, dz: 0, v: 0, s: 0 }, wait: 0 };
    agents.set(id, a); return a;
  }
  const now = () => Date.now() / 1000;
  function place(a, t) { sample(a.loop.tab, t + a.loop.phase - a.lag, a.pos); a.d = Math.hypot(a.pos.x - px, a.pos.z - pz); }
  function release(a) { if (a.slot < 0) return; active[a.slot] = null; a.slot = -1; a.lag = 0; a.wait = 0; }
  // every half second: the squares in reach, the ids they hold, which of them get a slot
  function roster() {
    keys = reach(px, pz);
    const live = new Set();
    for (const key of keys) { const nodes = nodesOf(key); if (!nodes.length) continue; for (let k = 0; k < want; k++) live.add(ensure(key, k).id); }
    for (const a of agents.values()) if (!live.has(a.id)) { release(a); if (a.loop) cache.set(a.id, a.loop); agents.delete(a.id); }
    if (cache.size > 96) { let n = cache.size - 96; for (const k of cache.keys()) { if (n-- <= 0) break; cache.delete(k); } }
    const t = now(), free = [];
    for (const a of agents.values()) if (a.loop && a.slot < 0) { place(a, t); if (a.d < radius) free.push(a); }
    for (const a of active) if (a && a.d > radius + hysteresis) release(a);
    free.sort((p, q) => p.d - q.d);
    for (let s = 0; s < slots && free.length; s++) if (!active[s]) { const a = free.shift(); active[s] = a; a.slot = s; }
    for (let s = slots; s < active.length; s++) if (active[s]) release(active[s]);
  }
  // one loop per call: the nearest square's missing one first
  function planOne() {
    for (const key of keys) for (let k = 0; k < want; k++) {
      const a = agents.get(key + ':' + k); if (!a || a.loop || a.dead) continue;
      const nodes = nodesOf(key); if (!nodes.length) { a.dead = true; continue; }
      const r = rng(seed(slug, a.id, 'start')), start = nodes[Math.floor(r() * nodes.length) % nodes.length];
      const loop = plan(a.id, start, r);
      if (loop) a.loop = loop; else a.dead = true;
      return true;
    }
    return false;
  }
  return {
    active, agents,
    // per frame: the player's place; returns the active list with fresh positions
    update(dt, x, z) {
      px = x; pz = z;
      if ((tick -= dt) <= 0) { tick = 0.5; roster(); }
      // routes are planned in the browser's spare time after a frame (a few ms each), one per frame otherwise
      if (typeof requestIdleCallback !== 'function') planOne();
      else if (!idle) { idle = true; requestIdleCallback(d => { idle = false; while (d.timeRemaining() > 3 && planOne()); }, { timeout: 500 }); }
      const t = now();
      for (const a of active) if (a) place(a, t);
      return active;
    },
    setCount(n) { slots = n; want = wantFor(n); tick = 0; },
    get count() { let n = 0; for (const a of active) if (a) n++; return n; },
    // how many active ones are within r of the player
    near(r) { let n = 0; for (const a of active) if (a && a.d < r) n++; return n; },
    get slots() { return slots; },
  };
}
