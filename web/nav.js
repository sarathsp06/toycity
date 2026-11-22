// Finding someone: a route line on the ground from you to another player, kept up to date as they move.
// On foot it follows the walking network (tools/walkgraph.mjs -> regions/<slug>/walks.json): footpaths,
// crossings and squares as they are, streets along their pavement, never down the middle of the road.
// In a car or on the bike it is the autopilot's road route, in the right-hand lane. The top bar says
// who, the next turn ("↰ Left in 40 m") and how far; it ends when you are next to them.
//
//   const nav = createNav({ scene, player, driving, autopilot, walksUrl, fromRD, heading, note });
//   nav.find({ id, name, pos: () => [x, z] | null });   // pos() null: they left
//   nav.update(dt); nav.stop(); nav.active; mountNav(document.getElementById('nav'), nav);
//
// The pure parts (walking A*, the pavement offset, turn finding, the arrow) are exported for tests.

export const FOUND = 6, FOUND_CAR = 12;
export const fmtDist = m => m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km';
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
// an arrow as seen on screen: yaw is the camera azimuth of city.js (camera at player + (sin yaw, cos yaw))
export function arrow(px, pz, tx, tz, yaw = 0) {
  const dx = tx - px, dz = tz - pz;
  const fwd = -dx * Math.sin(yaw) - dz * Math.cos(yaw), right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  return ARROWS[((Math.round(Math.atan2(right, fwd) / (Math.PI / 4)) % 8) + 8) % 8];
}
// the next real turn along a path ([[x, z]], cumulative metres S) after index i, within `ahead` metres:
// { dir: 'left' | 'right', in: metres } or null. Headings are taken over ~6 m either side, so the small
// kinks where a route crosses to the other pavement do not count. x is east, z is south.
export function nextTurn(P, S, i, at, ahead = 150) {
  const n = P.length;
  const back = k => { let j = k; while (j > 0 && S[k] - S[j] < 6) j--; return j; };
  const fwd = k => { let j = k; while (j < n - 1 && S[j] - S[k] < 6) j++; return j; };
  for (let k = Math.max(1, i + 1); k < n - 1 && S[k] - at < ahead; k++) {
    if (S[k] - at < 4) continue;
    const a = back(k), b = fwd(k); if (a === k || b === k) continue;
    const ax = P[k][0] - P[a][0], az = P[k][1] - P[a][1], bx = P[b][0] - P[k][0], bz = P[b][1] - P[k][1];
    const turn = Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
    if (Math.abs(turn) > 0.6) return { dir: turn > 0 ? 'right' : 'left', in: S[k] - at };
  }
  return null;
}

// ---------- the walking network ----------
const COST = [1, 1.1, 1.4, 3, 1.5];   // per metre, by the cost class of walkgraph.mjs: footpaths first
// { n, e } as in walks.json -> a graph in world coordinates. out[a]: [b, w, ...]; bit 12 of w marks a
// segment stored b->a, so the pavement side can be turned round when it is walked the other way.
export function walkGraph({ n, e }, fromRD) {
  const N = n.length / 2, xs = new Float64Array(N), zs = new Float64Array(N);
  for (let i = 0; i < N; i++) { const [x, z] = fromRD(n[2 * i] / 2, n[2 * i + 1] / 2); xs[i] = x; zs[i] = z; }
  const out = Array.from({ length: N }, () => []);
  for (let k = 0; k < e.length; k += 3) { const a = e[k], b = e[k + 1], w = e[k + 2]; out[a].push(b, w); out[b].push(a, w | 1 << 12); }
  const cell = new Map(), key = (x, z) => Math.floor(x / 40) + ',' + Math.floor(z / 40);
  for (let i = 0; i < N; i++) if (out[i].length) { const k = key(xs[i], zs[i]); (cell.get(k) || cell.set(k, []).get(k)).push(i); }
  // the nearest point of the network, preferring footpaths: a street node counts 8 m further away
  const nearest = (x, z) => {
    for (let r = 1; r < 10; r++) {
      let best = -1, bd = Infinity; const cx = Math.floor(x / 40), cz = Math.floor(z / 40);
      for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) for (const v of cell.get(i + ',' + j) || []) {
        let path = false; for (let k = 1; k < out[v].length; k += 2) if (!(out[v][k] & 3)) path = true;
        const d = Math.hypot(xs[v] - x, zs[v] - z) + (path ? 0 : 8); if (d < bd) { bd = d; best = v; }
      }
      if (best >= 0) return best;
    }
    return -1;
  };
  return { xs, zs, out, nearest, cost: new Float64Array(N), from: new Int32Array(N), via: new Int32Array(N), done: new Uint8Array(N) };
}
// A* by walking effort; returns [[node, w], ...] from a to b (w: the segment that led there), or null
export function walkRoute(g, a, b) {
  const { xs, zs, out, cost, from, via, done } = g; cost.fill(Infinity); from.fill(-1); done.fill(0);
  const h = v => Math.hypot(xs[v] - xs[b], zs[v] - zs[b]);
  const heap = []; const push = (f, v) => { heap.push([f, v]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= f) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  cost[a] = 0; push(h(a), a);
  while (heap.length) {
    const [, u] = pop(); if (done[u]) continue; done[u] = 1; if (u === b) break;
    const o = out[u];
    for (let k = 0; k < o.length; k += 2) {
      const v = o[k], w = o[k + 1], c = cost[u] + Math.hypot(xs[v] - xs[u], zs[v] - zs[u]) * COST[(w >> 8) & 7];
      if (c < cost[v]) { cost[v] = c; from[v] = u; via[v] = w; push(c + h(v), v); }
    }
  }
  if (a !== b && from[b] < 0) return null;
  const r = []; for (let v = b; v >= 0; v = from[v]) r.push([v, v === a ? 0 : via[v]]);
  return r.reverse();
}
// the route as drawn: each street segment moved onto its pavement (right of the walker unless the street
// has one on one side only), footpaths as they are. Where two segments keep the same side they meet at a
// mitre; where the side changes (a crossing, or onto a footpath) the line goes straight across.
export function walkLine(g, route) {
  const { xs, zs } = g, segs = [];
  for (let k = 1; k < route.length; k++) {
    const u = route[k - 1][0], v = route[k][0], w = route[k][1];
    const dx = xs[v] - xs[u], dz = zs[v] - zs[u], l = Math.hypot(dx, dz) || 1, rx = -dz / l, rz = dx / l;   // right of travel
    const side = w & 3, rev = (w >> 12) & 1, d = ((w >> 2) & 63) / 4;
    const o = side === 0 ? 0 : side === 3 ? d : (side === 1) !== !!rev ? d : -d;
    segs.push({ ax: xs[u] + rx * o, az: zs[u] + rz * o, bx: xs[v] + rx * o, bz: zs[v] + rz * o, o, dx: dx / l, dz: dz / l });
  }
  if (!segs.length) return [[xs[route[0][0]], zs[route[0][0]]]];
  const P = [[segs[0].ax, segs[0].az]];
  for (let k = 0; k < segs.length - 1; k++) {
    const s = segs[k], t = segs[k + 1];
    const cross = s.dx * t.dz - s.dz * t.dx;
    if (s.o === t.o && Math.abs(cross) > 0.05) {   // same side, a bend: where the two offset lines meet
      const u = ((t.ax - s.ax) * t.dz - (t.az - s.az) * t.dx) / cross;
      const mx = s.ax + s.dx * u, mz = s.az + s.dz * u;
      if (Math.hypot(mx - s.bx, mz - s.bz) < Math.abs(s.o) * 3) { P.push([mx, mz]); continue; }
    }
    P.push([s.bx, s.bz]); if (s.o !== t.o || Math.hypot(t.ax - s.bx, t.az - s.bz) > 0.3) P.push([t.ax, t.az]);
  }
  const e = segs[segs.length - 1]; P.push([e.bx, e.bz]);
  return P;
}

// ---------- the live part ----------
export function createNav({ scene, player, driving, autopilot, walksUrl, fromRD, heading = () => 0, note = () => {}, THREE: THREE0 } = {}) {
  let walks = null, walksP = null;
  const loadWalks = () => walksP ||= fetch(walksUrl).then(r => r.json()).then(d => (walks = walkGraph(d, fromRD))).catch(e => { console.warn('nav: no walking network', e); return null; });
  const mode = () => (driving?.driving ? (driving.model === 'bike' ? 'bike' : 'car') : 'foot');
  // a route from here to there, [[x, z], ...]: the walking network on foot, the road on wheels
  async function plan(from, to, m) {
    if (m === 'foot') {
      const g = await loadWalks();
      if (g) { const a = g.nearest(from.x, from.z), b = g.nearest(to.x, to.z); const r = a >= 0 && b >= 0 && walkRoute(g, a, b); if (r) return [[from.x, from.z], ...walkLine(g, r), [to.x, to.z]]; }
      return autopilot.plan(from, to, 'foot').catch(() => null);
    }
    return autopilot.plan(from, to, m).catch(() => null);
  }

  // the line: moving chevrons on a ribbon just above the ground. Per frame only the texture scrolls.
  let THREE = THREE0 || null, line = null, mat = null;
  if (scene) (THREE ? Promise.resolve(THREE) : import('three')).then(m => { THREE = m; makeLine(); }).catch(e => console.warn('nav: no line', e));
  function makeLine() {
    if (line || !THREE) return;
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(40,140,255,.55)'; x.fillRect(8, 0, 48, 64);
    x.strokeStyle = '#fff'; x.lineWidth = 9; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(18, 42); x.lineTo(32, 20); x.lineTo(46, 42); x.stroke();   // a chevron pointing along +v
    const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    line = new THREE.Mesh(new THREE.BufferGeometry(), mat); line.renderOrder = 8; line.frustumCulled = false; line.visible = false;
    scene.add(line);
  }

  let who = null, P = null, S = null, at = 0, gi = 0, planned = '', planning = false, planAt = -1e9, turn = null, t = 0, last = '';
  const listeners = new Set(), changed = () => { for (const f of listeners) try { f(api); } catch (e) { console.warn('nav listener', e); } };
  function setPath(pts, m) {
    P = pts; S = new Float64Array(pts.length); gi = 0; at = 0; turn = null;
    for (let k = 1; k < pts.length; k++) S[k] = S[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (!line) return;
    const n = pts.length, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = new Uint32Array((n - 1) * 6), W = m === 'foot' ? 0.7 : 1.3;
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      pos.set([pts[k][0] - tz * W, 0.3, pts[k][1] + tx * W, pts[k][0] + tz * W, 0.3, pts[k][1] - tx * W], k * 6);
      uv.set([0, S[k] / (W * 2.2), 1, S[k] / (W * 2.2)], k * 4);
      if (k < n - 1) idx.set([2 * k, 2 * k + 2, 2 * k + 1, 2 * k + 1, 2 * k + 2, 2 * k + 3], k * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    line.geometry.dispose(); line.geometry = g; line.visible = true;
  }
  function clear() { P = S = null; turn = null; planned = ''; if (line) line.visible = false; }
  async function replan() {
    const there = who?.pos(); if (!there || planning) return;
    planning = true; planAt = performance.now();
    const m = mode(), key = who.id + '|' + m, p = player.position, mine = who;
    const pts = await plan({ x: p.x, z: p.z }, { x: there[0], z: there[1] }, m);
    planning = false;
    if (who !== mine) return;   // stopped or someone else meanwhile
    planned = key;
    if (pts && pts.length > 1) setPath(pts, m); else { P = S = null; if (line) line.visible = false; }   // no route: the arrow points straight
  }
  // where you are along the path: the nearest segment, looked for a little behind and well ahead of the last
  function follow(px, pz) {
    let best = Infinity, bk = gi, bs = at;
    for (let k = Math.max(0, gi - 3); k < Math.min(P.length - 1, gi + 80); k++) {
      const [ax, az] = P[k], dx = P[k + 1][0] - ax, dz = P[k + 1][1] - az, l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)), ex = ax + dx * u - px, ez = az + dz * u - pz, d = ex * ex + ez * ez;
      if (d < best) { best = d; bk = k; bs = S[k] + u * (S[k + 1] - S[k]); }
    }
    gi = bk; at = bs;
    if (line) line.geometry.setDrawRange(bk * 6, (P.length - 1 - bk) * 6);
    return Math.sqrt(best);
  }
  const ahead = (m = 20) => { let k = gi + 1; while (k < P.length - 1 && S[k] - at < m) k++; return P[k]; };

  function find(target) {
    who = target; clear(); t = 0;
    note(`🧭 Finding ${who.name}. Follow the line.`);
    replan(); changed();
  }
  function stop(why) { if (!who) return; who = null; clear(); if (why) note(why); changed(); }

  const api = {
    find, stop,
    update(dt) {
      if (!who) return;
      const there = who.pos();
      if (!there) return stop(`👋 ${who.name} has left this area.`);
      const p = player.position, d = Math.hypot(there[0] - p.x, there[1] - p.z), m = mode();
      if (d < (m === 'foot' ? FOUND : FOUND_CAR)) return stop(`👋 You found ${who.name}!`);
      if (mat) mat.map.offset.y -= dt * (m === 'foot' ? 0.9 : 1.4);   // the chevrons flow towards them
      if ((t += dt) < 0.25) return;
      t = 0;
      const off = P ? follow(p.x, p.z) : 0;
      // they moved away from where the line ends, you left the line, or got in or out of a car
      const moved = P ? Math.hypot(P[P.length - 1][0] - there[0], P[P.length - 1][1] - there[1]) : 0;
      if (!planning && (planned !== who.id + '|' + m || off > 20 || moved > 25) && performance.now() - planAt > 3000) replan();
      turn = P ? nextTurn(P, S, gi, at) : null;
      const s = api.line; if (s !== last) { last = s; changed(); }
    },
    get active() { return who ? { id: who.id, name: who.name } : null; },
    get line() {
      if (!who) return '';
      const there = who.pos(); if (!there) return '';
      const p = player.position, d = Math.hypot(there[0] - p.x, there[1] - p.z), yaw = heading();
      if (!P || d < 25) return `🧭 ${who.name} · ${arrow(p.x, p.z, there[0], there[1], yaw)} ${fmtDist(d)}`;
      const left = Math.max(d, S[S.length - 1] - at);
      return turn && turn.in < 120 ? `🧭 ${who.name} · ${turn.dir === 'left' ? '↰ Left' : '↱ Right'} in ${fmtDist(turn.in)} · ${fmtDist(left)}`
        : `🧭 ${who.name} · ${arrow(p.x, p.z, ...ahead(), yaw)} ${fmtDist(left)}`;
    },
    get path() { return P; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    dispose() { listeners.clear(); who = null; if (line) { scene.remove(line); line.geometry.dispose(); mat.map.dispose(); mat.dispose(); line = null; } },
  };
  return api;
}

// the bar at the top while finding someone: the line text and a ✖ to stop. Markup: <div id="nav"></div>
export function mountNav(el, nav) {
  el.innerHTML = '<span class="text"></span><button type="button" title="Stop finding them" aria-label="Stop">✖</button>';
  const text = el.firstElementChild;
  el.lastElementChild.addEventListener('click', e => { e.stopPropagation(); nav.stop(); });
  const draw = () => { el.hidden = !nav.active; text.textContent = nav.line; };
  nav.onChange(draw); draw();
  return el;
}
