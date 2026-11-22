// Birds on the water: swans, geese, ducks, coots and moorhens on the town's ponds, lakes and canals.
//
// Which birds a pond gets comes from real Dutch survey data, not a guess: SPECIES holds Sovon's
// Vogelatlas figures (the share of the country's 5 x 5 km atlas squares where each species breeds,
// fieldwork 2013-2015) and the national breeding-pair estimates (2018-2020). facts.html shows the same
// table, so every number in the game is listed with its source in one place. The step from "breeds in
// this 5 x 5 km square" to "is on this particular pond" is our own assumption (SIZE_HALF, see chance()).
//
// The birds are the same for everyone: which birds a pond has and where they swim are worked out from
// the square, the pond and the wall clock (like the traffic in ambient.js), so nothing is sent around.
//
//   const birds = createBirds({ scene, THREE });
//   birds.add(tile, waterGeometry, toWorld);  birds.drop(tile);  birds.update(dt, x, z);
//
// The pure parts (finding separate ponds, the chance, picking birds) are exported for tests.

const SOVON = 'https://portal.sovon.nl/atlas/soorten/soort/';
const STATS = 'https://stats.sovon.nl/stats/soort/';
// breed: % of 5 x 5 km atlas squares with breeding, 2013-2015 (Sovon Vogelatlas, "Bezette blokken")
// winter: % of atlas squares where it was seen in winter, 2013-2015 (same page)
// pairs: national breeding-pair estimate (Sovon), years as given; null where we did not find it
// flock: [fewest, most] birds when a pond has them (our choice, by how the species is usually seen)
export const SPECIES = [
  { id: 'swan', nl: 'Knobbelzwaan', en: 'Mute swan', euring: 1520, breed: 72, winter: 85, pairs: '7,200–9,300 (2018–2020)', flock: [2, 2], young: [0, 4] },
  { id: 'blackswan', nl: 'Zwarte Zwaan', en: 'Black swan', euring: 1528, breed: 3, winter: 26, pairs: null, flock: [1, 2] },
  { id: 'greylag', nl: 'Grauwe Gans', en: 'Greylag goose', euring: 1610, breed: 81, winter: 91, pairs: '100,000–165,000 (2018–2020)', flock: [2, 9] },
  { id: 'canada', nl: 'Grote Canadese Gans', en: 'Canada goose', euring: 1661, breed: 58, winter: 67, pairs: null, flock: [2, 7] },
  { id: 'egyptian', nl: 'Nijlgans', en: 'Egyptian goose', euring: 1700, breed: 89, winter: 93, pairs: null, flock: [2, 4] },
  { id: 'mallard', nl: 'Wilde Eend', en: 'Mallard', euring: 1860, breed: 97, winter: 97, pairs: '180,000–280,000 (2015–2020)', flock: [2, 6] },
  { id: 'tufted', nl: 'Kuifeend', en: 'Tufted duck', euring: 2030, breed: 83, winter: 84, pairs: null, flock: [2, 6] },
  { id: 'coot', nl: 'Meerkoet', en: 'Coot', euring: 4290, breed: 91, winter: 89, pairs: '120,000–150,000 (2018–2020)', flock: [2, 5] },
  { id: 'moorhen', nl: 'Waterhoen', en: 'Moorhen', euring: 4240, breed: 86, winter: 88, pairs: null, flock: [1, 2] },
  { id: 'grebe', nl: 'Fuut', en: 'Great crested grebe', euring: 90, breed: 68, winter: 76, pairs: null, flock: [1, 2] },
].map(s => ({ ...s, atlas: SOVON + s.euring, stats: STATS + s.euring }));
export const ATLAS = { squares: 1685, size: '5 × 5 km', fieldwork: '2013–2015', book: 'Sovon (2018) Vogelatlas van Nederland', url: 'https://portal.sovon.nl/atlas/soorten' };

// Our assumption, not survey data: a pond of SIZE_HALF square metres has half the chance of its
// atlas square; bigger water more, a small canal less: chance = breed% x area / (area + SIZE_HALF).
// Ponds smaller than MIN_AREA get no birds at all.
export const SIZE_HALF = 3000, MIN_AREA = 250;
export const chance = (s, area) => area < MIN_AREA ? 0 : (s.breed / 100) * area / (area + SIZE_HALF);

// a tiny seeded PRNG (mulberry32) and a string hash: the same pond gives the same birds everywhere
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// which species are on a pond of `area` m², and how many of each: [{ s, n }]
export function pickBirds(area, seed) {
  const r = rng(seed), out = [];
  for (const s of SPECIES) {
    if (r() >= chance(s, area)) continue;
    const [lo, hi] = s.flock; let n = lo + Math.floor(r() * (hi - lo + 1));
    if (s.young) n += s.young[0] + Math.floor(r() * (s.young[1] - s.young[0] + 1));
    out.push({ s, n: Math.min(n, 2 + Math.floor(area / 120)) });   // a small pond is not crowded
  }
  return out;
}

// Separate bodies of water from one triangle mesh: triangles that share a vertex position belong
// together. pos: flat [x, z, ...] in metres (world), idx: triangle indices. Returns
// [{ tris: [a, b, c, ...] (indices into pos/2), area, cx, cz }] largest first.
export function waterBodies(pos, idx) {
  const nv = pos.length / 2, parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  // vertices at the same spot (meshes often repeat them) are one vertex
  const at = new Map();
  for (let i = 0; i < nv; i++) { const k = Math.round(pos[2 * i] * 10) + ',' + Math.round(pos[2 * i + 1] * 10); const j = at.get(k); if (j === undefined) at.set(k, i); else join(i, j); }
  for (let t = 0; t < idx.length; t += 3) { join(idx[t], idx[t + 1]); join(idx[t], idx[t + 2]); }
  const bodies = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2], root = find(a);
    const ar = Math.abs((pos[2 * b] - pos[2 * a]) * (pos[2 * c + 1] - pos[2 * a + 1]) - (pos[2 * c] - pos[2 * a]) * (pos[2 * b + 1] - pos[2 * a + 1])) / 2;
    if (!ar) continue;
    let w = bodies.get(root); if (!w) bodies.set(root, w = { tris: [], area: 0, cx: 0, cz: 0 });
    w.tris.push(a, b, c); w.area += ar;
    w.cx += ar * (pos[2 * a] + pos[2 * b] + pos[2 * c]) / 3; w.cz += ar * (pos[2 * a + 1] + pos[2 * b + 1] + pos[2 * c + 1]) / 3;
  }
  return [...bodies.values()].map(w => (w.cx /= w.area, w.cz /= w.area, w)).sort((p, q) => q.area - p.area);
}

// a random point on the water, uniformly by area
function samplePoint(pos, w, r, cum) {
  const x = r() * w.area; let k = 0, lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } k = lo * 3;
  let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
  const a = w.tris[k], b = w.tris[k + 1], c = w.tris[k + 2];
  return [pos[2 * a] + u * (pos[2 * b] - pos[2 * a]) + v * (pos[2 * c] - pos[2 * a]), pos[2 * a + 1] + u * (pos[2 * b + 1] - pos[2 * a + 1]) + v * (pos[2 * c + 1] - pos[2 * a + 1])];
}
// is (x, z) on this water: a coarse grid of the triangles, then point-in-triangle
function waterTest(pos, w) {
  const G = 8, grid = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
  for (let t = 0; t < w.tris.length; t += 3) {
    const xs = [0, 1, 2].map(k => pos[2 * w.tris[t + k]]), zs = [0, 1, 2].map(k => pos[2 * w.tris[t + k] + 1]);
    for (let i = Math.floor(Math.min(...xs) / G); i <= Math.floor(Math.max(...xs) / G); i++)
      for (let j = Math.floor(Math.min(...zs) / G); j <= Math.floor(Math.max(...zs) / G); j++) { const k = key(i, j); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(t); }
  }
  const inTri = (x, z, t) => {
    const [a, b, c] = [w.tris[t], w.tris[t + 1], w.tris[t + 2]];
    const ax = pos[2 * a], az = pos[2 * a + 1], bx = pos[2 * b], bz = pos[2 * b + 1], cx = pos[2 * c], cz = pos[2 * c + 1];
    const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz), d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz), d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  return (x, z) => (grid.get(key(Math.floor(x / G), Math.floor(z / G))) || []).some(t => inTri(x, z, t));
}
// spots on the pond a bird swims between, and which pairs can be swum straight (all water on the way)
export function swimSpots(pos, w, seed, n = 16) {
  const r = rng(seed), cum = new Float64Array(w.tris.length / 3); let acc = 0;
  for (let t = 0; t < w.tris.length; t += 3) {
    const a = w.tris[t], b = w.tris[t + 1], c = w.tris[t + 2];
    acc += Math.abs((pos[2 * b] - pos[2 * a]) * (pos[2 * c + 1] - pos[2 * a + 1]) - (pos[2 * c] - pos[2 * a]) * (pos[2 * b + 1] - pos[2 * a + 1])) / 2; cum[t / 3] = acc;
  }
  const wet = waterTest(pos, w), pts = [];
  for (let k = 0; k < n * 3 && pts.length < n; k++) { const p = samplePoint(pos, w, r, cum); if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => wet(p[0] + dx * 1.2, p[1] + dz * 1.2))) pts.push(p); }
  const links = pts.map(() => []);
  for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
    const [ax, az] = pts[a], [bx, bz] = pts[b], d = Math.hypot(bx - ax, bz - az); if (d > 60) continue;
    let ok = true; for (let s = 1; s < 8 && ok; s++) ok = wet(ax + (bx - ax) * s / 8, az + (bz - az) * s / 8);
    if (ok) { links[a].push(b); links[b].push(a); }
  }
  return { pts, links };
}

// ---------- the live part ----------
// Drawing: every species is one InstancedMesh (one draw call however many birds there are), filled each
// frame with only the birds within SEEN metres. The Canada goose and the mallard are low-poly models by
// Poly by Google (CC-BY 3.0, see models/CREDITS.txt), loaded the first time birds appear; until then, and
// for the other species, the birds are built here from a few shapes merged into one coloured mesh.
// Model space: x is forward, y up, metres, the waterline at y = 0.
const LEG = 14;          // seconds per swim (out to a spot, or back home), half of it resting
const SEEN = 180;        // birds farther than this are not drawn
const CAP = 96;          // birds of one kind drawn at once
export const MODELS = { canada: { url: 'models/goose.glb', len: 0.85, water: 0.36 }, mallard: { url: 'models/mallard.glb', len: 0.55, water: 0.3 } };
export function createBirds({ scene, THREE, loadModel }) {
  const live = new Map();   // tile -> flocks
  const kinds = new Map();  // kind -> InstancedMesh
  const flat = new THREE.MeshLambertMaterial({ vertexColors: true });

  // ---- shapes merged into one geometry with a colour per vertex ----
  function merge(parts) {
    const P = [], N = [], C = [], col = new THREE.Color();
    for (const [g0, hex, m] of parts) {
      const g = g0.index ? g0.toNonIndexed() : g0; if (m) g.applyMatrix4(m);
      const p = g.attributes.position.array, n = g.attributes.normal.array; col.set(hex);
      for (let k = 0; k < p.length; k++) { P.push(p[k]); N.push(n[k]); }
      for (let k = 0; k < p.length / 3; k++) C.push(col.r, col.g, col.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.computeBoundingSphere(); return g;
  }
  const M = (x, y, z, rz = 0, ry = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz)), new THREE.Vector3(1, 1, 1));
  const sphere = (r, sx, sy, sz, w = 12, h = 9) => new THREE.SphereGeometry(r, w, h).scale(sx, sy, sz);
  // a mute swan: long low body with the tail swept up, wings held a little raised, an S-shaped neck,
  // the orange bill with its black knob. Cygnets are the same shape, small and grey.
  function swan(body, bill, knob, k = 1) {
    const b = sphere(0.5, 1.15, 0.48, 0.62, 18, 12), p = b.attributes.position;
    for (let v = 0; v < p.count; v++) { const x = p.getX(v); if (x < -0.25) p.setY(v, p.getY(v) + (-x - 0.25) * 0.45); }
    b.computeVertexNormals();
    const neck = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0.4, 0.1], [0.5, 0.32], [0.44, 0.56], [0.47, 0.76], [0.56, 0.83]].map(([x, y]) => new THREE.Vector3(x, y, 0))), 18, 0.05, 8);
    const g = merge([
      [b, body, M(0, 0.06, 0)],
      [sphere(0.5, 0.78, 0.26, 0.3), body, M(-0.14, 0.2, 0.16, 0.18)], [sphere(0.5, 0.78, 0.26, 0.3), body, M(-0.14, 0.2, -0.16, 0.18)],
      [neck, body], [sphere(0.075, 1.35, 0.95, 0.85), body, M(0.6, 0.835, 0)],
      [new THREE.ConeGeometry(0.034, 0.15, 8), bill, M(0.72, 0.8, 0, -Math.PI / 2 - 0.35)],
      [sphere(0.028, 1, 1, 0.8, 8, 6), knob, M(0.665, 0.845, 0)],
      [sphere(0.012, 1, 1, 1, 6, 4), 0x111111, M(0.63, 0.855, 0.05)], [sphere(0.012, 1, 1, 1, 6, 4), 0x111111, M(0.63, 0.855, -0.05)],
    ]);
    return k === 1 ? g : g.scale(k, k, k);
  }
  // the others: body, tail, neck, head and bill, sized and coloured per species
  const LOOK = {
    greylag: { body: 0x8d8579, neck: 0x9a9184, head: 0x9a9184, beak: 0xf08a3c, len: 0.75, neck_h: 0.38 },
    canada: { body: 0x7a6650, neck: 0x141414, head: 0x141414, beak: 0x141414, len: 0.8, neck_h: 0.45, chin: 0xffffff },
    egyptian: { body: 0xb69a78, neck: 0xd6c5a8, head: 0xd6c5a8, beak: 0xe9a3a3, len: 0.6, neck_h: 0.32 },
    mallard: { body: 0x9c8f80, neck: 0x1d5a33, head: 0x1d5a33, beak: 0xe5c22a, len: 0.48, neck_h: 0.16 },
    tufted: { body: 0x232326, neck: 0x232326, head: 0x232326, beak: 0x8a96a8, len: 0.4, neck_h: 0.12, side: 0xf2f2f2 },
    coot: { body: 0x202024, neck: 0x202024, head: 0x202024, beak: 0xf4f1ea, len: 0.34, neck_h: 0.12 },
    moorhen: { body: 0x2c2a33, neck: 0x2c2a33, head: 0x2c2a33, beak: 0xd8312a, len: 0.3, neck_h: 0.12 },
    grebe: { body: 0x8b7867, neck: 0xf2ece4, head: 0x5a3c28, beak: 0xd9a0a0, len: 0.45, neck_h: 0.3 },
  };
  function simple(L) {
    const s = L.len, nh = L.neck_h, hy = 0.18 * s + nh;
    const parts = [
      [sphere(0.5, 1, 0.55, 0.62, 12, 8), L.body, M(0, 0.05 * s, 0).scale(new THREE.Vector3(s, s, s))],
      [new THREE.ConeGeometry(0.1, 0.22, 6).scale(s, s, s), L.body, M(-0.45 * s, 0.12 * s, 0, Math.PI / 2 + 0.5)],
      [new THREE.CylinderGeometry(0.07 * s, 0.1 * s, nh, 7).translate(0, nh / 2, 0), L.neck, M(0.32 * s, 0.12 * s, 0)],
      [sphere(0.13 * s, 1.25, 1, 0.9, 9, 7), L.head, M(0.32 * s, hy, 0)],
      [new THREE.ConeGeometry(0.05 * s, 0.2 * s, 6), L.beak, M(0.32 * s + 0.2 * s, hy - 0.02 * s, 0, -Math.PI / 2)],
    ];
    if (L.side) parts.push([sphere(0.5, 0.7, 0.33, 0.645, 10, 6), L.side, M(-0.05 * s, 0.05 * s, 0).scale(new THREE.Vector3(s, s, s))]);
    if (L.chin) parts.push([sphere(0.06 * s, 1.4, 0.6, 1.3, 6, 4), L.chin, M(0.34 * s, hy - 0.06 * s, 0)]);
    return merge(parts);
  }
  const BUILD = {
    swan: () => swan(0xf6f6f2, 0xe8702a, 0x161616), cygnet: () => swan(0x9c968c, 0x3a3a3a, 0x3a3a3a, 0.48),
    blackswan: () => swan(0x1d1d24, 0xc9302c, 0xeeeeee, 0.95),
  };
  function kind(id) {
    let m = kinds.get(id); if (m) return m;
    m = new THREE.InstancedMesh((BUILD[id] || (() => simple(LOOK[id])))(), flat, CAP);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; m.castShadow = m.receiveShadow = false;
    kinds.set(id, m); scene.add(m);
    if (MODELS[id] && loadModel) swapModel(id, m);
    return m;
  }
  // a real model for this species: one mesh, turned to face +x, scaled to the bird's length, set at the waterline
  function swapModel(id, m) {
    const d = MODELS[id];
    loadModel(d.url).then(gltf => {
      let src = null; gltf.scene.updateMatrixWorld(true); gltf.scene.traverse(o => { if (o.isMesh && !src) src = o; });
      if (!src) return;
      const g = src.geometry.clone().applyMatrix4(src.matrixWorld); g.rotateY(Math.PI / 2);   // the models face +z
      g.computeBoundingBox(); const b = g.boundingBox.clone(), k = d.len / (b.max.x - b.min.x);   // a copy: translate() recomputes the box
      g.translate(-(b.max.x + b.min.x) / 2, -b.min.y, -(b.max.z + b.min.z) / 2).scale(k, k, k);
      g.translate(0, -(b.max.y - b.min.y) * k * d.water, 0); g.computeBoundingSphere();
      const map = src.material.map; if (map) map.colorSpace = THREE.SRGBColorSpace;
      const old = m.geometry; m.geometry = g; m.material = new THREE.MeshLambertMaterial({ map }); old.dispose();
    }).catch(e => console.warn('birds: model', d.url, e));
  }

  // a tile's water came in: find its ponds and put birds on them
  function add(tile, pos, idx, y, key) {
    drop(tile);
    const bodies = waterBodies(pos, idx), flocks = [];
    bodies.slice(0, 40).forEach((w, bi) => {
      if (w.area < MIN_AREA) return;
      const seed = hash(key + ':' + bi + ':' + Math.round(w.area)), picked = pickBirds(w.area, seed);
      if (!picked.length) return;
      const spots = swimSpots(pos, w, seed ^ 0x9e3779b9);
      if (!spots.pts.length) return;
      picked.forEach(({ s, n }, fi) => {
        const r = rng(seed + fi * 7919), home = Math.floor(r() * spots.pts.length), birds = [];
        for (let k = 0; k < n; k++) {
          const small = !!s.young && k >= s.flock[1];
          // swans: the cygnets follow in a line behind the pair; the others loosely around the first
          const off = s.young ? [-(k * 0.9 + 0.4) * (small ? 1 : 0.5), (k % 2 ? 1 : -1) * 0.35 * (small ? 0 : 1)] : [(r() - 0.5) * 2.6, (r() - 0.5) * 2.6];
          birds.push({ kind: small ? 'cygnet' : s.id, off, phase: r() * 10, size: 0.92 + r() * 0.16 });
        }
        flocks.push({ s, birds, spots, home, phase: r() * LEG * 2, seed: seed + fi, y, x: spots.pts[home][0], z: spots.pts[home][1], h: r() * 6.28 });
      });
    });
    if (flocks.length) live.set(tile, flocks);
  }
  function drop(tile) { live.delete(tile); }

  // where a flock is at time t: leg 2k swims home -> spot k, leg 2k+1 back; half of each leg resting
  function at(f, t) {
    const { pts, links } = f.spots, L = links[f.home];
    const u = (t + f.phase) / LEG, k = Math.floor(u), frac = u - k;
    if (!L.length) return [pts[f.home][0], pts[f.home][1], 0];
    const pick = Math.floor(rng(f.seed + Math.floor(k / 2) * 104729)() * L.length), away = pts[L[pick]], home = pts[f.home];
    const [a, b] = k % 2 ? [away, home] : [home, away];
    const m = Math.min(1, frac * 2), e = m * m * (3 - 2 * m);   // swim the first half, rest the second
    return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, frac < 0.5 ? 1 : 0, Math.atan2(-(b[1] - a[1]), b[0] - a[0])];
  }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  return {
    add, drop,
    update(dt, px, pz) {
      const t = (Date.now() / 1000) % 1e6;   // the wall clock: everyone sees the same swim
      for (const m of kinds.values()) m.count = 0;
      for (const flocks of live.values()) for (const f of flocks) {
        if (Math.abs(f.x - px) > SEEN || Math.abs(f.z - pz) > SEEN) continue;
        const [x, z, swimming, dir] = at(f, t);
        f.x = x; f.z = z;
        if (swimming && dir !== undefined) { let d = dir - f.h; d = Math.atan2(Math.sin(d), Math.cos(d)); f.h += d * Math.min(1, dt * 2.5); }
        const c = Math.cos(f.h), s = Math.sin(f.h), nod = f.s.id === 'coot' || f.s.id === 'moorhen';
        for (const b of f.birds) {
          const m = kind(b.kind); if (m.count >= CAP) continue;
          const w = t * 1.6 + b.phase;   // offsets turn with the flock; a gentle bob; coots nod as they swim
          _p.set(x + b.off[0] * c + b.off[1] * s, f.y + 0.015 * Math.sin(w), z - b.off[0] * s + b.off[1] * c);
          _e.set(0, f.h + 0.15 * Math.sin(w * 0.3), (swimming && nod ? 0.12 * Math.sin(w * 6) : 0.03 * Math.sin(w * 0.9)));
          m.setMatrixAt(m.count++, _m.compose(_p, _q.setFromEuler(_e), _s.setScalar(b.size)));
        }
      }
      for (const m of kinds.values()) if (m.count) m.instanceMatrix.needsUpdate = true;
    },
    kind,   // the InstancedMesh of one kind (made on first use): for previews
    get count() { let n = 0; for (const flocks of live.values()) for (const f of flocks) n += f.birds.length; return n; },
    get drawCalls() { let n = 0; for (const m of kinds.values()) if (m.count) n++; return n; },
    // where every flock is right now (also the ones too far away to be drawn)
    get flocks() { const t = (Date.now() / 1000) % 1e6, out = []; for (const flocks of live.values()) for (const f of flocks) { const [x, z] = at(f, t); out.push({ species: f.s.en, n: f.birds.length, x, z }); } return out; },
  };
}
