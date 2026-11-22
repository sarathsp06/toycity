// Autopilot: drive yourself to an address, a place or a spot on the map, along real streets.
//
// The route comes from OpenStreetMap's Valhalla router (valhalla1.openstreetmap.de, run by FOSSGIS),
// asked for the vehicle you are in: "auto" for a car, "motorcycle" for the bike. It knows one-way
// streets, turn restrictions and who may drive where, and it gives turn-by-turn directions and the
// time for each stretch (so the speed to drive there). When it can't be reached, or its route leaves
// the part of town the game has, the route is planned here instead: an A* search over the region's
// own OpenStreetMap streets (tools/roadgraph.mjs -> regions/<slug>/roads.json, loaded when first
// needed), which also keeps to one-way streets, access rules for cars or motorbikes and speed limits.
//
// The car keeps to the right-hand side of the road (the Netherlands drives on the right), steers
// towards a point a little way ahead on the route (pure pursuit) and slows down for bends. It drives
// through parked cars and people rather than getting stuck on them, backs up and tries again when a
// wall is in the way, and as a last resort hops to the next point of the route.
//
//   const ap = createAutopilot({ roadsUrl, fromRD, fromWGS, toWGS, inside })
//   await ap.start(car, { x, z }, label, vehicle)    vehicle: 'car' or 'bike'
//   ap.drive(dt, car)  -> { throttle, steer, boost, ghost, hop, arrived } or null when there is nothing to do
//   ap.next            -> the next turn: { text, in } (metres), or null

const TOP = 22, BEND = 3.5, ARRIVE = 8;     // m/s: never above 80 km/h, 13 km/h in sharp bends; metres
// the town's own cars and people plan short loops (ambient.js): a search that needs more nodes than this
// gives up the same way in every browser, so the traffic stays the same for everyone
const LOOP_CAP = 20000;
const LANE = { car: 1.5, bike: 1.1, foot: 0 };       // metres right of the road's centre line
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const COSTING = { car: 'auto', bike: 'motorcycle', foot: 'pedestrian' };
const ARROW = { 9: '↗', 10: '↱', 11: '↱', 12: '⤸', 13: '⤸', 14: '↰', 15: '↰', 16: '↖', 26: '⟳', 27: '⟳', 4: '🏁', 5: '🏁', 6: '🏁' };
const GRACE = 2500;                         // ms to wait for the online router before planning here
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));   // an angle into -pi..pi
const after = ms => new Promise(res => setTimeout(res, ms));

// Valhalla's shapes: Google's polyline encoding with six decimals -> [[lat, lon], ...]
function decode(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  const next = () => { let b, s = 0, r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < str.length) { lat += next(); lon += next(); out.push([lat / 1e6, lon / 1e6]); }
  return out;
}

// ---------- the path a vehicle follows ----------
// Drop points closer than 2 m, then move the line to the right-hand side of the road, square to the
// average of the two neighbouring directions. In a corner the offset shrinks (a right turn would
// otherwise cut over the inside kerb), and near the start and the end it fades out.
// Also used by the ambient traffic (traffic.js) and exported for it.
export function lanePath(pts, lane, steps = []) {
  const path = [], map = [];   // map: shape index -> path index, for the turn-by-turn steps
  for (let i = 0; i < pts.length; i++) {
    const q = path[path.length - 1];
    if (!q || Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]) > 2) path.push([pts[i][0], pts[i][1]]);
    map[i] = path.length - 1;
  }
  const s = [0]; for (let i = 1; i < path.length; i++) s.push(s[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const L = s[s.length - 1], out = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[Math.max(0, i - 1)], n = path[Math.min(path.length - 1, i + 1)];
    let dx = n[0] - p[0], dz = n[1] - p[1]; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    // a segment's own direction, to scale the mitre
    const a = path[i], b = path[Math.min(path.length - 1, i + 1)], sd = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cos = sd ? Math.max(0, (dx * (b[0] - a[0]) + dz * (b[1] - a[1])) / sd) : 1;
    const fade = Math.min(1, s[i] / 12, (L - s[i]) / 12), o = lane * fade * cos * cos;
    out.push([a[0] - dz * o, a[1] + dx * o]);   // right of the direction (dx, dz) is (-dz, dx)
  }
  return { path: out, s, steps: steps.map(st => ({ ...st, s: s[map[Math.min(st.at, map.length - 1)]] })) };
}

const laneOffset = lanePath;

export function createAutopilot({ roadsUrl, fromRD, fromWGS, toWGS, inside }) {
  let graph = null, route = null;

  // ---------- the online route ----------
  async function online(car, to, vehicle) {
    const [la0, lo0] = toWGS(car.x, car.z), [la1, lo1] = toWGS(to.x, to.z);
    const q = { locations: [{ lat: la0, lon: lo0, heading: (Math.atan2(car.fx, -car.fz) * 180 / Math.PI + 360) % 360, heading_tolerance: 60 }, { lat: la1, lon: lo1 }],
      costing: COSTING[vehicle] || 'auto', units: 'kilometers', language: 'en-US', directions_options: { units: 'kilometers' } };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(q)), { signal: ctl.signal });
      if (!r.ok) return null;
      const leg = (await r.json()).trip?.legs?.[0]; if (!leg) return null;
      const pts = decode(leg.shape).map(([la, lo]) => fromWGS(la, lo));
      if (!pts.every(([x, z]) => inside(x, z))) return null;   // it leaves the town we have: plan here instead
      // each manoeuvre: where it starts on the shape, what to say, and how fast that stretch goes
      const steps = leg.maneuvers.map(m => ({ at: m.begin_shape_index, type: m.type, text: m.instruction,
        speed: m.time > 0 ? m.length * 1000 / m.time : null }));
      return { pts, steps, source: 'osm' };
    } catch { return null; } finally { clearTimeout(t); }
  }

  // ---------- the local route (no network) ----------
  async function load() {
    if (graph) return graph;
    const { n, e } = await (await fetch(roadsUrl)).json();
    const N = n.length / 2, xs = new Float64Array(N), zs = new Float64Array(N);
    for (let i = 0; i < N; i++) { const [x, z] = fromRD(n[2 * i] / 2, n[2 * i + 1] / 2); xs[i] = x; zs[i] = z; }
    // out[a]: [b, flags] for every segment you may drive from a (flags: see roadgraph.mjs)
    const out = Array.from({ length: N }, () => []);
    for (let k = 0; k < e.length; k += 3) {
      const a = e[k], b = e[k + 1], f = e[k + 2];
      if (f & 1) out[a].push(b, f); if (f & 2) out[b].push(a, f);
    }
    const cell = new Map(), key = (x, z) => Math.floor(x / 50) + ',' + Math.floor(z / 50);
    for (let i = 0; i < N; i++) { if (!out[i].length) continue; const k = key(xs[i], zs[i]); (cell.get(k) || cell.set(k, []).get(k)).push(i); }
    // the nearest junction or bend this vehicle may drive away from
    const nearest = (x, z, bit) => {
      for (let r = 0; r < 12; r++) {
        let best = -1, bd = Infinity;
        const cx = Math.floor(x / 50), cz = Math.floor(z / 50);
        for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++)
          for (const n of cell.get(i + ',' + j) || []) {
            if (!out[n].some((v, k) => k % 2 && v & bit)) continue;
            const d = (xs[n] - x) ** 2 + (zs[n] - z) ** 2; if (d < bd) { bd = d; best = n; }
          }
        if (best >= 0) return best;
      }
      return -1;
    };
    // the search's working arrays, kept with the graph. Nothing is wiped between searches: an entry
    // counts only when its stamp is this search's number (seen: cost and from are set, shut: done)
    const cost = new Float64Array(N), from = new Int32Array(N), seen = new Uint32Array(N), shut = new Uint32Array(N);
    return (graph = { xs, zs, out, nearest, cost, from, seen, shut, gen: 0, hk: new Float64Array(4096), hi: new Int32Array(4096) });
  }
  // A* on travel time: length / speed limit, only along segments open to this vehicle and in the
  // allowed direction. A flat binary heap (keys and node ids side by side) keeps it quick on 100,000 nodes.
  // cap: give up after that many nodes (a place that cannot be reached would otherwise search everything)
  function astar(g, a, b, bit, cap = Infinity) {
    const { xs, zs, cost, from, seen, shut } = g, gen = ++g.gen;
    const costOf = v => (seen[v] === gen ? cost[v] : Infinity);
    const h = n => Math.hypot(xs[n] - xs[b], zs[n] - zs[b]) / 36;   // 130 km/h: never more than the truth
    let hk = g.hk, hi = g.hi, n = 0;   // the heap holds n entries; it grows when a search needs more
    const push = (key, id) => {
      if (n === hk.length) { const k2 = new Float64Array(n * 2), i2 = new Int32Array(n * 2); k2.set(hk); i2.set(hi); hk = g.hk = k2; hi = g.hi = i2; }
      let i = n++; while (i) { const p = (i - 1) >> 1; if (hk[p] <= key) break; hk[i] = hk[p]; hi[i] = hi[p]; i = p; }
      hk[i] = key; hi[i] = id;
    };
    const pop = () => {   // take the top, then sift the last entry down from the root
      const top = hi[0], key = hk[--n], id = hi[n]; if (!n) return top;
      let i = 0; for (;;) { const l = 2 * i + 1; if (l >= n) break; const m = l + 1 < n && hk[l + 1] < hk[l] ? l + 1 : l; if (hk[m] >= key) break; hk[i] = hk[m]; hi[i] = hi[m]; i = m; }
      hk[i] = key; hi[i] = id;
      return top;
    };
    seen[a] = gen; cost[a] = 0; from[a] = -1; push(h(a), a);
    let found = a === b;
    for (let left = cap; n && left > 0; left--) {
      const u = pop(); if (shut[u] === gen) continue; shut[u] = gen;
      if (u === b) { found = true; break; }
      const o = g.out[u];
      for (let k = 0; k < o.length; k += 2) {
        const m = o[k], f = o[k + 1]; if (!(f & bit)) continue;
        const c = cost[u] + Math.hypot(xs[m] - xs[u], zs[m] - zs[u]) / ((f >> 4) / 3.6);
        if (c < costOf(m)) { seen[m] = gen; cost[m] = c; from[m] = u; push(c + h(m), m); }
      }
    }
    if (!found) return null;
    const out = []; for (let v = b; v >= 0; v = from[v]) out.push(v);   // node ids, destination first
    return out.reverse();
  }
  async function local(car, to, vehicle) {
    const g = await load(), bit = vehicle === 'bike' ? 8 : 4;
    const a = g.nearest(car.x, car.z, bit), b = g.nearest(to.x, to.z, bit);
    if (a < 0 || b < 0) return null;
    const ids = astar(g, a, b, bit); if (!ids) return null;
    return { pts: ids.map(v => [g.xs[v], g.zs[v]]), steps: [], source: 'local' };
  }

  const lanePath = laneOffset;   // see the top of the file

  // Ask the online router and load the local graph at the same time. The online route wins when it
  // answers within GRACE; after that the local one is used as soon as it is ready, and `late` gets the
  // online route if it still arrives (start swaps it in while that is safe). Null: no route at all.
  async function pick(car, to, vehicle, late = () => {}) {
    const web = online(car, to, vehicle), loc = local(car, to, vehicle).catch(() => null);
    const first = await Promise.race([web, after(GRACE)]);   // undefined: no answer yet
    if (first) return first;
    if (first === null) return loc;   // the router said no (unreachable, or it leaves town)
    const r = await loc;
    if (!r) return web;               // nothing local either: the online one is the last hope
    web.then(o => o && late(o));
    return r;
  }
  function build(r, car, to, label, vehicle) {
    r.pts.unshift([car.x, car.z]); r.pts.push([to.x, to.z]);
    r.steps.forEach(st => st.at++);   // the car's own position went in front
    const { path, s, steps } = lanePath(r.pts, LANE[vehicle] ?? 1.5, r.steps);
    return { path, s, steps, i: 1, label, length: s[s.length - 1], stuck: 0, back: 0, tries: 0, lastGood: 0, t: 0, source: r.source };
  }
  // every start (and stop) counts up: a route that arrives for an older request is thrown away
  let gen = 0;
  async function start(car, to, label, vehicle = 'car') {
    const my = ++gen;
    // the online route arriving after the local one: take it over while the car is still near the start
    // (both routes begin there), picking up from the new path's nearest point; later on it stays as is
    const late = o => {
      const old = route; if (my !== gen || !old) return;
      const at = old.car || car; if (Math.hypot(at.x - car.x, at.z - car.z) > 12) return;
      const nr = build(o, car, to, label, vehicle), P = nr.path; let bi = 1, bd = Infinity;
      for (let k = 1; k < P.length; k++) { const d = Math.hypot(P[k][0] - at.x, P[k][1] - at.z); if (d < bd) { bd = d; bi = k; } }
      nr.i = bi; nr.t = old.t; nr.lastGood = old.t; nr.car = old.car; route = nr;
    };
    const r = await pick(car, to, vehicle, late);
    if (!r || my !== gen) return null;   // no route, or stopped / started again meanwhile
    route = build(r, car, to, label, vehicle);
    return { length: route.length, source: r.source };
  }
  const stop = () => { route = null; gen++; };
  // just the route, for someone walking it (vehicle 'foot'): [[x, z], ...] from here to there, or null
  async function plan(from, to, vehicle = 'foot') {
    const r = vehicle === 'foot' ? await online(from, to, vehicle) : await pick(from, to, vehicle);
    if (!r) return null;
    r.pts.unshift([from.x, from.z]); r.pts.push([to.x, to.z]);
    return lanePath(r.pts, LANE[vehicle] ?? 0, []).path;
  }

  // how far along the route the car is, in metres
  function progress(car) {
    const r = route, [px, pz] = r.path[r.i];
    return r.s[r.i] - Math.hypot(px - car.x, pz - car.z);
  }

  // one frame of driving: car = { x, z, fx, fz, speed } (fx, fz: the bonnet's direction)
  function drive(dt, car) {
    const r = route; if (!r) return null;
    r.t += dt; r.car = car;
    const P = r.path, end = P[P.length - 1];
    const left = Math.hypot(end[0] - car.x, end[1] - car.z);
    if (left < ARRIVE) return { throttle: car.speed > 0.3 ? -1 : 0, steer: 0, ghost: true, arrived: Math.abs(car.speed) < 0.3 };
    // move on along the route once a point is close, or already behind us
    while (r.i < P.length - 1) {
      const [px, pz] = P[r.i], d = Math.hypot(px - car.x, pz - car.z), ahead = (px - car.x) * car.fx + (pz - car.z) * car.fz;
      if (d < 5 || (ahead < 0 && d < 15)) { r.i++; r.lastGood = r.t; } else break;
    }
    // the point we aim at: a lookahead distance along the route
    const look = Math.max(6, Math.abs(car.speed) * 1.1);
    let tx = P[r.i][0], tz = P[r.i][1], acc = Math.hypot(tx - car.x, tz - car.z);
    for (let k = r.i; k < P.length - 1 && acc < look; k++) { tx = P[k + 1][0]; tz = P[k + 1][1]; acc += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]); }
    const diff = wrap(Math.atan2(-(tz - car.z), tx - car.x) - Math.atan2(-car.fz, car.fx));
    // how much the route bends in the next 25 m (more at speed): slow down for it
    let bend = 0, d0 = 0;
    for (let k = r.i; k < P.length - 2 && d0 < 25 + Math.abs(car.speed); k++) {
      const a1 = Math.atan2(P[k + 1][1] - P[k][1], P[k + 1][0] - P[k][0]), a2 = Math.atan2(P[k + 2][1] - P[k + 1][1], P[k + 2][0] - P[k + 1][0]);
      bend = Math.max(bend, Math.abs(wrap(a2 - a1))); d0 += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
    }
    // cruise at the speed the router expects on this stretch, or 50 km/h (30 on the local route)
    const at = progress(car); let step = null;   // the last manoeuvre that has begun
    for (let k = r.steps.length - 1; k >= 0; k--) if (r.steps[k].s <= at + 1) { step = r.steps[k]; break; }
    const cruise = Math.min(TOP, step?.speed ? step.speed * 1.1 : r.source === 'osm' ? 14 : 11);
    let target = Math.max(BEND, cruise - (cruise - BEND) * Math.min(1, Math.max(bend, Math.abs(diff)) / 1.2));
    target = Math.min(target, 2 + left * 0.5);   // ease into the destination
    // stuck (a wall, a bollard): back up with the wheel the other way, then try again; after a few
    // tries, hop to the next point of the route so the trip always finishes
    if (r.back > 0) { r.back -= dt; return { throttle: -1, steer: diff > 0 ? -1 : 1, ghost: true }; }
    r.stuck = Math.abs(car.speed) < 0.6 ? r.stuck + dt : 0;
    if (r.stuck > 1.2) {
      r.stuck = 0; r.tries++;
      if (r.tries > 2 || r.t - r.lastGood > 20) { r.tries = 0; r.lastGood = r.t; const k = Math.min(r.i + 1, P.length - 1); r.i = k; return { throttle: 0, steer: 0, ghost: true, hop: P[k], toward: P[Math.min(k + 1, P.length - 1)] }; }
      r.back = 1.1;
    }
    const throttle = car.speed < target ? 1 : car.speed > target + 1.5 ? -0.7 : 0;
    return { throttle, steer: Math.max(-1, Math.min(1, diff * 2.2)), boost: target > 14, ghost: true };
  }

  return {
    start, stop, drive, plan,
    // the region's own road graph and A* over it, for the ambient traffic and people (ambient.js):
    // graph() loads it once; route(a, b, bit) is the node list a..b for that vehicle bit (sync, once loaded)
    local: { graph: load, route: (a, b, bit) => (graph ? astar(graph, a, b, bit, LOOP_CAP) : null) },
    get active() { return !!route; },
    get label() { return route?.label; },
    // what is left of the trip, in metres
    get remaining() { const r = route; return r && r.car ? Math.max(0, r.length - progress(r.car)) : r ? r.length : 0; },
    // the next turn on the online route: { text: '↱ Turn right onto Rietgors.', in: metres }
    get next() {
      const r = route; if (!r || !r.car || !r.steps.length) return null;
      const at = progress(r.car), st = r.steps.find(st => st.s > at + 3 && st.type !== 1 && st.type !== 2 && st.type !== 3);
      return st ? { text: (ARROW[st.type] ? ARROW[st.type] + ' ' : '') + st.text.replace(/\.$/, ''), in: st.s - at } : null;
    },
  };
}
