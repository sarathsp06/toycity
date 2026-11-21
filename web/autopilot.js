// Autopilot: drive yourself to an address, a place or a spot on the map, along real streets.
// The street network is every drivable OpenStreetMap way of the region (tools/roadgraph.mjs ->
// regions/<slug>/roads.json, loaded the first time you use it). The route is an A* search over it;
// the car follows it by steering towards a point a little way ahead (pure pursuit) and slows down
// for bends. It drives through parked cars and people rather than getting stuck on them, backs up and
// tries again when a wall is in the way, and as a last resort hops to the next point of the route.
//
//   const ap = createAutopilot({ roadsUrl, fromRD })
//   await ap.start(car, { x, z }, label)    plan a route from the car to x, z (world metres)
//   ap.drive(dt, car)  -> { throttle, steer, ghost, hop } or null when there is nothing to do

const CRUISE = 13, BEND = 3.5, ARRIVE = 8;   // m/s: about 47 km/h on straights, 13 km/h in sharp bends; metres

export function createAutopilot({ roadsUrl, fromRD }) {
  let graph = null, route = null;

  async function load() {
    if (graph) return graph;
    const { n, e } = await (await fetch(roadsUrl)).json();
    const N = n.length / 2, xs = new Float64Array(N), zs = new Float64Array(N), adj = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++) { const [x, z] = fromRD(n[2 * i] / 2, n[2 * i + 1] / 2); xs[i] = x; zs[i] = z; }
    for (let k = 0; k < e.length; k += 2) { adj[e[k]].push(e[k + 1]); adj[e[k + 1]].push(e[k]); }
    // a 50 m grid to find the nearest node quickly
    const cell = new Map(), key = (x, z) => Math.floor(x / 50) + ',' + Math.floor(z / 50);
    for (let i = 0; i < N; i++) { if (!adj[i].length) continue; const k = key(xs[i], zs[i]); (cell.get(k) || cell.set(k, []).get(k)).push(i); }
    const nearest = (x, z) => {
      for (let r = 0; r < 12; r++) {
        let best = -1, bd = Infinity;
        const cx = Math.floor(x / 50), cz = Math.floor(z / 50);
        for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++)
          for (const n of cell.get(i + ',' + j) || []) { const d = (xs[n] - x) ** 2 + (zs[n] - z) ** 2; if (d < bd) { bd = d; best = n; } }
        if (best >= 0) return best;
      }
      return -1;
    };
    return (graph = { xs, zs, adj, nearest });
  }

  // A* over the street graph; a small binary heap keeps it quick on 100,000 nodes
  function astar(g, a, b) {
    const N = g.xs.length, cost = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const h = n => Math.hypot(g.xs[n] - g.xs[b], g.zs[n] - g.zs[b]);
    const heap = [[h(a), a]]; cost[a] = 0;
    const push = it => { heap.push(it); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [, n] = pop(); if (done[n]) continue; done[n] = 1;
      if (n === b) break;
      for (const m of g.adj[n]) {
        const c = cost[n] + Math.hypot(g.xs[m] - g.xs[n], g.zs[m] - g.zs[n]);
        if (c < cost[m]) { cost[m] = c; from[m] = n; push([c + h(m), m]); }
      }
    }
    if (from[b] < 0 && a !== b) return null;
    const out = []; for (let n = b; n >= 0; n = from[n]) out.push([g.xs[n], g.zs[n]]);
    return out.reverse();
  }

  async function start(car, to, label) {
    const g = await load();
    const a = g.nearest(car.x, car.z), b = g.nearest(to.x, to.z);
    if (a < 0 || b < 0) return null;
    const pts = astar(g, a, b); if (!pts) return null;
    pts.unshift([car.x, car.z]); pts.push([to.x, to.z]);
    // drop points closer than 2 m to the previous one: smoother steering
    const path = [pts[0]]; for (const p of pts) { const q = path[path.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 2) path.push(p); }
    let length = 0; for (let i = 1; i < path.length; i++) length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    route = { path, i: 1, label, length, stuck: 0, back: 0, tries: 0, lastGood: 0, t: 0, done: false };
    return { length };
  }
  const stop = () => { route = null; };

  // one frame of driving: car = { x, z, fx, fz, speed } (fx, fz: the bonnet's direction)
  function drive(dt, car) {
    const r = route; if (!r) return null;
    r.t += dt;
    const P = r.path, end = P[P.length - 1];
    const left = Math.hypot(end[0] - car.x, end[1] - car.z);
    if (left < ARRIVE || r.i >= P.length) { r.done = true; return { throttle: car.speed > 0.3 ? -1 : 0, steer: 0, ghost: true, arrived: Math.abs(car.speed) < 0.3 }; }
    // move on along the route once a point is close, or already behind us
    while (r.i < P.length - 1) {
      const [px, pz] = P[r.i], d = Math.hypot(px - car.x, pz - car.z), ahead = (px - car.x) * car.fx + (pz - car.z) * car.fz;
      if (d < 5 || (ahead < 0 && d < 15)) { r.i++; r.lastGood = r.t; } else break;
    }
    // the point we aim at: a lookahead distance along the route
    const look = Math.max(6, Math.abs(car.speed) * 1.1);
    let tx = P[r.i][0], tz = P[r.i][1], acc = Math.hypot(tx - car.x, tz - car.z);
    for (let k = r.i; k < P.length - 1 && acc < look; k++) { tx = P[k + 1][0]; tz = P[k + 1][1]; acc += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]); }
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    const diff = wrap(Math.atan2(-(tz - car.z), tx - car.x) - Math.atan2(-car.fz, car.fx));
    // how much the route bends in the next 25 m: slow down for it
    let bend = 0, d0 = 0;
    for (let k = r.i; k < P.length - 2 && d0 < 25; k++) {
      const a1 = Math.atan2(P[k + 1][1] - P[k][1], P[k + 1][0] - P[k][0]), a2 = Math.atan2(P[k + 2][1] - P[k + 1][1], P[k + 2][0] - P[k + 1][0]);
      bend = Math.max(bend, Math.abs(wrap(a2 - a1))); d0 += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
    }
    let target = Math.max(BEND, CRUISE - (CRUISE - BEND) * Math.min(1, Math.max(bend, Math.abs(diff)) / 1.2));
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
    return { throttle, steer: Math.max(-1, Math.min(1, diff * 2.2)), ghost: true };
  }

  return {
    start, stop, drive,
    get active() { return !!route; },
    get label() { return route?.label; },
    // what is left of the trip, in metres
    get remaining() {
      const r = route; if (!r) return 0;
      let s = 0; for (let i = r.i; i < r.path.length - 1; i++) s += Math.hypot(r.path[i + 1][0] - r.path[i][0], r.path[i + 1][1] - r.path[i][1]);
      return s;
    },
  };
}
