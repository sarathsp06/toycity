// Step 2 of the square pipeline: turn data/<slug>/raw/I_J.json into GPU-ready files so the browser
// only uploads buffers and never triangulates, extrudes or places anything itself.
//
// Usage: node tools/buildtiles.mjs SLUG [--shard K/N] [--force]
// Writes web/regions/<slug>/t/I_J.b.bin  LoD 2.2 buildings (near)
//                               I_J.d.bin  ground surfaces, water, hedges, fences, plates, instances, collision, labels (near)
//                               I_J.f.bin  LoD 1.2 blocks (far)
//        and web/regions/<slug>/tiles.json once every square is built.
//
// File format (gzip): u32 header length | header JSON | zero padding to 4 bytes | binary blob.
// Positions are Uint16 at 2 cm in three.js square-local space, offset so they stay positive:
//   stored = ((x + 400) / .02, (up + 50) / .02, (z + 910) / .02), with z = -north.
// The page places each mesh at square origin + (-400, -50, -910) and scales it by 0.02.
import * as THREE from 'three';
import * as BU from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pc from 'polygon-clipping';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = 500, Q = 0.02, OX = 400, OY = 50, OZ = 910;
const BASE = 0.14;
const TOP = { road: 0.15, brickroad: 0.15, parking: 0.16, cycle: 0.16, paved: 0.18, yard: 0.19, grass: 0.19, verge: 0.2, sand: 0.18, pavement: 0.27, kerbisland: 0.27, plants: 0.55 };
const STREET = new Set(['road', 'brickroad', 'parking', 'pavement', 'cycle', 'kerbisland', 'verge']);
// for doors: a wall faces the street when public ground (anything but a private garden) lies in front of it
const PRIVATE = new Set(['yard']);
const WALK_OVER_WATER = new Set(['road', 'brickroad', 'parking', 'pavement', 'cycle', 'kerbisland', 'paved']);
export const CHARS = '0123456789abcdefghijklmnopqrstuvwxyz-/ ';

// ---------- small helpers ----------
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)) >>> 0) / 4294967296; }
function hash(x, y) { return (Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(y * 10), 19349663)) >>> 0; }
const centroid = p => { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; };
function pip(x, y, poly) {
  let ok = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi) ok = !ok;
  }
  return ok;
}
function polyIndex(items, cell = 20) {
  const map = new Map();
  items.forEach((it, idx) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of it.p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    it._bb = [x0, y0, x1, y1];
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
      const k = gx + ',' + gy; (map.get(k) || map.set(k, []).get(k)).push(idx);
    }
  });
  return (x, y) => {
    for (const idx of map.get(Math.floor(x / cell) + ',' + Math.floor(y / cell)) || []) {
      const it = items[idx], b = it._bb;
      if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && pip(x, y, it.p) && !(it.holes || []).some(h => pip(x, y, h))) return it;
    }
    return null;
  };
}
// Douglas-Peucker: BGT draws curves with many points; 5 cm tolerance is invisible at street level
function simplify(ring, tol = 0.05) {
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length); keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((ring[i][0] - ax) * dy - (ring[i][1] - ay) * dx) / L; if (d > best) { best = d; bi = i; } }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : ring;
}
const simp = rec => ({ ...rec, p: simplify(rec.p), holes: (rec.holes || []).map(h => simplify(h)).filter(h => h.length >= 3) });
function shapeFrom(poly, holes = []) {
  const s = new THREE.Shape(poly.map(p => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) s.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
  return s;
}
// extrude a footprint between two heights; UVs are square-local metres (seamless across squares,
// because every texture size divides 500 m)
function slab(rec, y0, y1, sidesOnly = false) {
  const g = new THREE.ExtrudeGeometry(shapeFrom(rec.p, rec.holes || []), { depth: y1 - y0, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, x, -z); else uv.setXY(i, x * Math.abs(nor.getZ(i)) + z * Math.abs(nor.getX(i)), y);
  }
  return g;
}
function flatPoly(rec, y) {
  const g = new THREE.ShapeGeometry(shapeFrom(rec.p, rec.holes || []));
  g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), -pos.getZ(i));
  return g;
}

// ---------- encoding ----------
class Packer {
  constructor() { this.chunks = []; this.size = 0; this.header = { groups: {}, inst: {}, meta: {} }; }
  add(typed) {
    const pad = (4 - (this.size % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.size += pad; }
    const off = this.size, buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    this.chunks.push(buf); this.size += buf.length;
    return [off, typed.length];
  }
  geometry(name, geos, { color = false, uv: keepUv = true } = {}) {
    geos = geos.filter(Boolean);
    if (!geos.length) return;
    for (const g of geos) {
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', ...(keepUv ? ['uv'] : []), ...(color ? ['color'] : [])].includes(k)) g.deleteAttribute(k);
      if (g.index) g.copy(g.toNonIndexed());
      if (keepUv && !g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.attributes.normal) g.computeVertexNormals();
      if (color && !g.attributes.color) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    }
    let m = BU.mergeGeometries(geos);
    if (!m) return;
    m = BU.mergeVertices(m, 1e-3);
    const p = m.attributes.position, n = m.attributes.normal, uv = m.attributes.uv, c = m.attributes.color;
    const P = new Uint16Array(p.count * 3), N = new Int8Array(p.count * 4), U = uv ? new Float32Array(p.count * 2) : null;
    const clampQ = v => Math.max(0, Math.min(65535, Math.round(v)));
    for (let i = 0; i < p.count; i++) {
      P[3 * i] = clampQ((p.getX(i) + OX) / Q); P[3 * i + 1] = clampQ((p.getY(i) + OY) / Q); P[3 * i + 2] = clampQ((p.getZ(i) + OZ) / Q);
      N[4 * i] = Math.round(n.getX(i) * 127); N[4 * i + 1] = Math.round(n.getY(i) * 127); N[4 * i + 2] = Math.round(n.getZ(i) * 127);
      if (U) { U[2 * i] = uv.getX(i); U[2 * i + 1] = uv.getY(i); }
    }
    const idx = m.index.array, I = p.count < 65536 ? new Uint16Array(idx) : new Uint32Array(idx);
    // groups without uv get square-local metres as texture coordinates in the shader (world-aligned ground)
    const rec = { pos: this.add(P), nrm: this.add(N), idx: this.add(I), i32: I instanceof Uint32Array };
    if (U) rec.uv = this.add(U);
    if (c) { const C = new Uint8Array(p.count * 4); for (let i = 0; i < p.count; i++) { C[4 * i] = c.getX(i) * 255; C[4 * i + 1] = c.getY(i) * 255; C[4 * i + 2] = c.getZ(i) * 255; C[4 * i + 3] = 255; } rec.col = this.add(C); }
    this.header.groups[name] = rec;
  }
  // instances: [x, up, z, rotY, scale, rgb] in three.js square-local metres
  instances(name, list) { if (list.length) this.header.inst[name] = this.add(new Float32Array(list.flat())); }
  write(file) {
    const head = Buffer.from(JSON.stringify(this.header));
    const pad = (4 - ((4 + head.length) % 4)) % 4;
    const len = Buffer.alloc(4); len.writeUInt32LE(head.length + pad);
    const all = Buffer.concat([len, head, Buffer.alloc(pad, 32), ...this.chunks]);
    fs.writeFileSync(file + '.tmp', zlib.gzipSync(all, { level: 7 }));
    fs.renameSync(file + '.tmp', file);
    return all.length;
  }
}

// ---------- 3D BAG mesh -> wall and roof triangles ----------
const nV = new THREE.Vector3(), tV = new THREE.Vector3(), aV = new THREE.Vector3(), bV = new THREE.Vector3(), cV = new THREE.Vector3();
function bagMesh(m, { onWall, ao = true } = {}) {
  const out = { w: { pos: [], uv: [], col: [] }, r: { pos: [], uv: [], col: [] } };
  const V = k => [m.v[3 * k], m.v[3 * k + 2] + BASE, -m.v[3 * k + 1]];
  m.f.forEach((face, fi) => {
    const sem = m.s[fi]; if (sem === 0 || face.length < 3) return;
    const pts = face.map(V);
    nV.set(0, 0, 0);
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; nV.x += (p[1] - q[1]) * (p[2] + q[2]); nV.y += (p[2] - q[2]) * (p[0] + q[0]); nV.z += (p[0] - q[0]) * (p[1] + q[1]); }
    if (nV.lengthSq() < 1e-10) return;
    nV.normalize();
    const ax = Math.abs(nV.x), ay = Math.abs(nV.y), az = Math.abs(nV.z);
    const [u_, w_] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(pts.map(p => new THREE.Vector2(p[u_], p[w_])), []); } catch { return; }
    let kind, uvOf;
    if (sem === 1) { kind = 'r'; uvOf = p => [p[0] / T, -p[2] / T]; }               // aerial photo, straight down
    else {
      kind = 'w'; tV.set(-nV.z, 0, nV.x); if (tV.lengthSq() < 1e-6) tV.set(1, 0, 0); tV.normalize();
      const tx = tV.x, tz = tV.z; uvOf = p => [(p[0] * tx + p[2] * tz) / 3, (p[1] - BASE) / 2.8];
      if (onWall) onWall(pts, nV.clone());
    }
    const o = out[kind];
    for (const tri of tris) {
      aV.fromArray(pts[tri[0]]); bV.fromArray(pts[tri[1]]); cV.fromArray(pts[tri[2]]);
      const flip = cV.sub(aV).cross(bV.sub(aV)).dot(nV) > 0;
      for (const k of (flip ? [tri[0], tri[2], tri[1]] : tri)) {
        const p = pts[k]; o.pos.push(...p); o.uv.push(...uvOf(p));
        const s = kind === 'w' && ao ? 0.72 + 0.28 * Math.min((p[1] - BASE) / 3, 1) : 1;
        o.col.push(s, s, s);
      }
    }
  });
  const mk = o => { if (!o.pos.length) return null; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(o.col, 3)); g.computeVertexNormals(); return g; };
  return { wall: mk(out.w), roof: mk(out.r) };
}
function extrudeFootprint(b) {
  try {
    const g = slab({ p: b.p }, BASE, BASE + Math.max(b.h || 6, 2.5));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    return g;
  } catch { return null; }
}

// ---------- collision bitmap: 0.5 m cells, 1 bit each ----------
const CR = 0.5, CN = T / CR;
function rasterize(bits, rings, value) {
  // even-odd scanline fill of one polygon (outer ring + holes) in square-local metres
  let y0 = 1e9, y1 = -1e9;
  for (const r of rings) for (const [, y] of r) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const r0 = Math.max(0, Math.floor(y0 / CR)), r1 = Math.min(CN - 1, Math.ceil(y1 / CR));
  for (let row = r0; row <= r1; row++) {
    const yc = (row + 0.5) * CR, xs = [];
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > yc) !== (yj > yc)) xs.push(xi + (yc - yi) * (xj - xi) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / CR - 0.5)), c1 = Math.min(CN - 1, Math.floor(xs[k + 1] / CR - 0.5));
      for (let col = c0; col <= c1; col++) {
        const bit = row * CN + col;
        if (value) bits[bit >> 3] |= 1 << (bit & 7); else bits[bit >> 3] &= ~(1 << (bit & 7));
      }
    }
  }
}

// ---------- one square ----------
function buildSquare(raw, outDir) {
  const key = `${raw.i}_${raw.j}`;
  const buildings = raw.buildings;
  const buildingAt = polyIndex([...buildings.map(b => ({ p: b.p })), ...raw.blockers.map(p => ({ p }))]);
  const surfaceAt = polyIndex(raw.surfaces);
  const kindAt = (x, y) => buildingAt(x, y) ? 'building' : (surfaceAt(x, y) || {}).k || null;
  const stats = {};

  // ===== near buildings (LoD 2.2) and the walls that get doors and windows =====
  const B = new Packer(), wallGeos = [[], [], [], []], roofGeos = [], wallFaces = [];
  buildings.forEach((bd, bi) => {
    const [cx, cy] = centroid(bd.p), h = hash(cx, cy);
    const mesh = bd.m22 || bd.m12;
    const g = mesh ? bagMesh(mesh, { onWall: (pts, n) => wallFaces.push({ pts, n, bi }) }) : { wall: extrudeFootprint(bd), roof: null };
    const big = bd.kind === 'school' || bd.kind === 'apartments' || bd.h > 12;
    if (g.wall) wallGeos[big ? 1 : h % 4].push(g.wall);
    if (g.roof) roofGeos.push(g.roof);
  });
  wallGeos.forEach((gs, i) => B.geometry('wall' + i, gs, { color: true }));
  B.geometry('roof', roofGeos);
  stats.b = B.write(path.join(outDir, key + '.b.bin'));

  // ===== far buildings (LoD 1.2 blocks, one wall material) =====
  const F = new Packer(), fw = [], fr = [];
  for (const bd of buildings) {
    const g = bd.m12 ? bagMesh(bd.m12, { ao: false }) : { wall: extrudeFootprint(bd), roof: null };
    if (g.wall) fw.push(g.wall); if (g.roof) fr.push(g.roof);
  }
  F.geometry('wall', fw); F.geometry('roof', fr);
  stats.f = F.write(path.join(outDir, key + '.f.bin'));

  // ===== near detail =====
  const D = new Packer();
  D.geometry('gwall', raw.walls.map(h => { try { return slab(simp(h), BASE, 1.0); } catch { return null; } }));

  // doors and windows: doors and full rows on street-facing walls, fewer on other open walls, none on party walls
  const doorWall = new Map(), win = [], lit = [], doors = [], fallbackDoor = {};
  for (const w of wallFaces) {
    const { pts, n } = w;
    const tx = -n.z, tz = n.x, tl = Math.hypot(tx, tz) || 1, ux = tx / tl, uz = tz / tl;
    const S = p => p[0] * ux + p[2] * uz;
    const bottom = Math.min(...pts.map(p => p[1]));
    const low = pts.filter(p => p[1] < bottom + 0.4), high = pts.filter(p => p[1] > bottom + 1.8);
    if (low.length < 2 || !high.length) continue;
    const s0 = Math.min(...low.map(S)), s1 = Math.max(...low.map(S)), L = s1 - s0;
    const eave = Math.min(...high.map(p => p[1]));
    if (L < 1.4 || eave - bottom < 2.3) continue;
    const ref = low[0], sRef = S(ref);
    const at = (sv, y, out = 0) => [ref[0] + ux * (sv - sRef) + n.x * out, y, ref[2] + uz * (sv - sRef) + n.z * out];
    const mid = at((s0 + s1) / 2, bottom + 1, 0.8);
    if (kindAt(mid[0], -mid[2]) === 'building') continue;
    let street = 0;
    for (let d = 1.5; d <= 30; d += 1.5) {
      const q = at((s0 + s1) / 2, 0, d), k = kindAt(q[0], -q[2]);
      if (k === 'building') break;
      if (k && !PRIVATE.has(k)) { street = d; break; }
    }
    w.open = true;
    w.ground = bottom < BASE + 0.5;          // only walls that reach the ground can hold the front door
    Object.assign(w, { L, s0, s1, bottom, eave, at, street, ux, uz });
    if (street && w.ground) { const cur = doorWall.get(w.bi); if (!cur || street < cur.street - 0.5 || (Math.abs(street - cur.street) <= 0.5 && L > cur.L)) doorWall.set(w.bi, w); }
  }
  {
    const addrIdx = polyIndex(buildings.map((b, k) => ({ p: b.p, k }))), addressed = new Set(), addrStreet = new Map();
    for (const a of raw.addr) { const hit = addrIdx(a.x, a.y); if (hit) { addressed.add(hit.k); if (a.s && !addrStreet.has(hit.k)) addrStreet.set(hit.k, a.s); } }
    // the front door faces the street the address is on (terraces often back onto a public footpath)
    const streetPts = new Map();
    for (const st of raw.streets) (streetPts.get(st.n) || streetPts.set(st.n, []).get(st.n)).push(st.p);
    const nearestOn = (name, x, y) => {
      let best = 1e18, bx = 0, by = 0;
      for (const pts of streetPts.get(name) || []) for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, ay] = pts[k], dx = pts[k + 1][0] - ax, dy = pts[k + 1][1] - ay;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const qx = ax + dx * u, qy = ay + dy * u, d = (qx - x) ** 2 + (qy - y) ** 2;
        if (d < best) { best = d; bx = qx; by = qy; }
      }
      return best < 1e18 ? [bx, by] : null;
    };
    const byB = new Map();
    for (const w of wallFaces) if (w.open && w.ground && w.L >= 1.4) (byB.get(w.bi) || byB.set(w.bi, []).get(w.bi)).push(w);
    for (const [bi, ws] of byB) {
      const name = addrStreet.get(bi); if (!name) continue;
      const [cx, cy] = centroid(buildings[bi].p), q = nearestOn(name, cx, cy); if (!q) continue;
      let best = null, bs = 0.35;
      for (const w of ws) {
        const m = w.at((w.s0 + w.s1) / 2, 0, 0), mx = m[0], my = -m[2];
        const dx = q[0] - mx, dy = q[1] - my, dl = Math.hypot(dx, dy) || 1;
        const sc = (w.n.x * dx + -w.n.z * dy) / dl + (w.street ? 0.15 : 0) + Math.min(w.L, 6) / 60;
        if (sc > bs) { bs = sc; best = w; }
      }
      if (best) { doorWall.set(bi, best); best.street = best.street || 1; }
    }
    for (const w of wallFaces) {
      if (!w.open || !w.ground || doorWall.has(w.bi) || !addressed.has(w.bi)) continue;
      const cur = w.bi in fallbackDoor ? fallbackDoor[w.bi] : null;
      if (!cur || w.L > cur.L) fallbackDoor[w.bi] = w;
    }
    for (const [bi, w] of Object.entries(fallbackDoor)) if (!doorWall.has(+bi)) { doorWall.set(+bi, w); w.street = w.street || 1; }
  }
  const DOOR = [0x2e4a3a, 0x23314a, 0x1e1f22, 0x6b4a2f, 0xe8e6df, 0x7a2a26, 0x3d5a6b];
  const doorAt = new Map();
  for (const w of wallFaces) {
    if (w.L === undefined || (!w.street && w.L < 3)) continue;
    const rot = Math.atan2(w.n.x, w.n.z), q = rng(hash(w.s0 * 7, w.bottom * 13 + w.bi));
    const slots = Math.max(1, Math.floor((w.L - 0.4) / 2.6)), floors = Math.max(1, Math.floor((w.eave - w.bottom + 0.4) / 2.8));
    const doorSlot = doorWall.get(w.bi) === w ? Math.floor(q() * slots) : -1;
    for (let f = 0; f < floors; f++) for (let i = 0; i < slots; i++) {
      const sv = w.s0 + w.L * (i + 0.5) / slots, base = w.bottom + f * 2.8;
      if (f === 0 && i === doorSlot) {
        const p = w.at(sv, base + 1.1, 0.04);
        doors.push([...p, rot, 1, DOOR[hash(p[0], p[2]) % DOOR.length]]);
        doorAt.set(w.bi, { p, rot, ux: w.ux, uz: w.uz, n: w.n, w });
        continue;
      }
      if (!w.street && q() < 0.35) continue;
      if (base + 2.3 > w.eave - 0.1) continue;
      (q() < 0.3 ? lit : win).push([...w.at(sv, base + 1.55, 0.04), rot, 1, 0xffffff]);
    }
  }
  D.instances('win', win); D.instances('winlit', lit); D.instances('door', doors);
  stats.openings = win.length + lit.length + doors.length;

  // a path from every front door to the street: cut through hedges, planting beds and garden fences
  const paths = [];
  for (const [, d] of doorAt) {
    const w = d.w, len = Math.min(Math.max(w.street >= 1.5 ? w.street + 0.6 : 3, 2), 16);
    const nx = d.n.x, ny = -d.n.z, ux = d.ux, uy = -d.uz, x0 = d.p[0], y0 = -d.p[2], hw = 0.65;
    const a = [x0 + nx * 0.02, y0 + ny * 0.02], b = [x0 + nx * len, y0 + ny * len];
    paths.push([[a[0] - ux * hw, a[1] - uy * hw], [a[0] + ux * hw, a[1] + uy * hw], [b[0] + ux * hw, b[1] + uy * hw], [b[0] - ux * hw, b[1] - uy * hw], [a[0] - ux * hw, a[1] - uy * hw]]);
  }
  const pathBB = paths.map(r => [Math.min(...r.map(p => p[0])), Math.min(...r.map(p => p[1])), Math.max(...r.map(p => p[0])), Math.max(...r.map(p => p[1]))]);
  function cutPaths(rec) {
    const [x0, y0, x1, y1] = [Math.min(...rec.p.map(p => p[0])), Math.min(...rec.p.map(p => p[1])), Math.max(...rec.p.map(p => p[0])), Math.max(...rec.p.map(p => p[1]))];
    const hits = paths.filter((_, i) => pathBB[i][0] < x1 && pathBB[i][2] > x0 && pathBB[i][1] < y1 && pathBB[i][3] > y0);
    if (!hits.length) return [rec];
    try {
      return pc.difference([rec.p, ...(rec.holes || [])], ...hits.map(r => [r])).map(poly => ({ ...rec, p: poly[0], holes: poly.slice(1) }));
    } catch { return [rec]; }
  }

  const byKind = {};
  const RAISED = new Set(['pavement', 'kerbisland', 'plants', 'verge', 'grass', 'yard']);
  for (const s0 of raw.surfaces) {
    const top = TOP[s0.k] ?? 0.18;
    // raised planting beds get the front paths cut out of them, like the hedges
    for (const s of (s0.k === 'plants' ? cutPaths(s0) : [s0]).map(simp))
      try { (byKind[s.k] ||= []).push(RAISED.has(s.k) ? slab(s, BASE, top) : flatPoly(s, top)); } catch {}
  }
  // the paths themselves: brick pavers from the door to the street, just above garden level
  D.geometry('surf:path', paths.map(r => { try { return flatPoly({ p: r }, 0.205); } catch { return null; } }), { uv: false });
  for (const [k, gs] of Object.entries(byKind)) D.geometry('surf:' + k, gs, { uv: false });
  D.geometry('water', raw.water.map(w => { try { return flatPoly(simp(w), 0.1); } catch { return null; } }), { uv: false });
  D.geometry('hedge', raw.hedges.flatMap(cutPaths).map(h => { try { return slab(simp(h), BASE, 1.1); } catch { return null; } }));
  // house number plates next to each front door, from the OSM addresses inside the footprint
  {
    const addrs = buildings.map(() => []);
    const idx = polyIndex(buildings.map((b, k) => ({ p: b.p, k })));
    for (const a of raw.addr) { const hit = idx(a.x, a.y); if (hit) addrs[hit.k].push(a); }
    const geos = [];
    buildings.forEach((b, k) => {
      const d = doorAt.get(k); if (!d || !addrs[k].length) return;
      const nums = [...new Set(addrs[k].map(a => a.n.toLowerCase()))].sort((a, b) => a.length - b.length || a.localeCompare(b, 'nl', { numeric: true }));
      const text = nums.length > 2 ? nums[0] + '-' + nums[nums.length - 1] : nums.join('/');
      const ch = 0.17, hgt = 0.26, w = ch * text.length + 0.06, pos = [], uv = [];
      for (let c = 0; c < text.length; c++) {
        const ci = Math.max(CHARS.indexOf(text[c]), 0), xl = -w / 2 + 0.03 + c * ch;
        const u0 = ci / CHARS.length, u1 = (ci + 1) / CHARS.length;
        const quad = [[xl, -hgt / 2, u0, 0], [xl + ch, -hgt / 2, u1, 0], [xl + ch, hgt / 2, u1, 1], [xl, -hgt / 2, u0, 0], [xl + ch, hgt / 2, u1, 1], [xl, hgt / 2, u0, 1]];
        for (const [x, y, u, v] of quad) { pos.push(x, y, 0); uv.push(u, v); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
      g.rotateY(d.rot); g.translate(d.p[0] + d.ux * 0.85 + d.n.x * 0.02, d.p[1] + 0.75, d.p[2] + d.uz * 0.85 + d.n.z * 0.02);
      geos.push(g);
    });
    D.geometry('plates', geos);
  }

  // parked cars in the BGT parking bays
  const cars = [], PAINT = [0xf2f2f2, 0x1c1c1e, 0x8a8f96, 0xc4c7cc, 0x24365c, 0x8c1c1c, 0x3f4a3c, 0xe8e2d0];
  for (const sf of raw.surfaces) {
    if (sf.k !== 'parking') continue;
    let best = 0, ux = 1, uy = 0;
    for (let i = 0; i + 1 < sf.p.length; i++) { const dx = sf.p[i + 1][0] - sf.p[i][0], dy = sf.p[i + 1][1] - sf.p[i][1], l = Math.hypot(dx, dy); if (l > best) { best = l; ux = dx / l; uy = dy / l; } }
    const vx = -uy, vy = ux, U = sf.p.map(p => p[0] * ux + p[1] * uy), V = sf.p.map(p => p[0] * vx + p[1] * vy);
    const u0 = Math.min(...U), u1 = Math.max(...U), v0 = Math.min(...V), v1 = Math.max(...V), W = v1 - v0;
    if (W > 40 || u1 - u0 > 200) continue;
    const parallel = W < 3.6, step = parallel ? 6 : 2.5, rows = parallel ? 1 : Math.max(1, Math.floor(W / 5));
    for (let r = 0; r < rows; r++) for (let u = u0 + step / 2; u < u1 - step / 2 + 0.01; u += step) {
      const v = v0 + W * (r + 0.5) / rows, x = u * ux + v * vx, y = u * uy + v * vy;
      const hx = parallel ? ux : vx, hy = parallel ? uy : vy;
      if (![0, 1.7, -1.7].every(k => pip(x + hx * k, y + hy * k, sf.p))) continue;
      const q = rng(hash(x, y)); if (q() > 0.72) continue;
      cars.push([x, 0.17, -y, Math.atan2(hy, hx) + (q() < 0.5 ? Math.PI : 0), 1, PAINT[Math.floor(q() * PAINT.length)]]);
    }
  }
  D.instances('car', cars); stats.cars = cars.length;

  // garden boundaries derived from BGT yards: low hedge on the street side, 1.8 m fence between gardens
  const fence = [], fhedge = [], solidRects = [], lowRects = [];
  {
    const seen = new Set();
    for (const sf of raw.surfaces) {
      if (sf.k !== 'yard') continue;
      let A = 0; for (let i = 0, j = sf.p.length - 1; i < sf.p.length; j = i++) A += sf.p[j][0] * sf.p[i][1] - sf.p[i][0] * sf.p[j][1];
      const sgn = A > 0 ? 1 : -1;
      for (let i = 0; i + 1 < sf.p.length; i++) {
        const [ax, ay] = sf.p[i], [bx, by] = sf.p[i + 1], dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
        if (l < 0.8) continue;
        const onEdge = v => v < 0.05 || v > T - 0.05;
        if ((onEdge(ax) && onEdge(bx) && Math.abs(ax - bx) < 0.1) || (onEdge(ay) && onEdge(by) && Math.abs(ay - by) < 0.1)) continue; // square border
        const nx = sgn * dy / l, ny = -sgn * dx / l, mx = (ax + bx) / 2, my = (ay + by) / 2;
        const key = Math.round(mx * 2) + ',' + Math.round(my * 2); if (seen.has(key)) continue; seen.add(key);
        const k = kindAt(mx + nx * 0.6, my + ny * 0.6);
        if (k === 'building' || kindAt(mx - nx * 0.6, my - ny * 0.6) === 'building') continue;
        const front = STREET.has(k), th = front ? 0.3 : 0.03;
        const rect = { p: [[ax - nx * th, ay - ny * th], [bx - nx * th, by - ny * th], [bx + nx * th, by + ny * th], [ax + nx * th, ay + ny * th], [ax - nx * th, ay - ny * th]] };
        for (const piece of cutPaths(rect))
          try { (front ? fhedge : fence).push(slab(piece, BASE, front ? 0.95 : 1.8)); (front ? lowRects : solidRects).push(piece.p); } catch {}
      }
    }
  }
  D.geometry('fence', fence); D.geometry('fhedge', fhedge);

  // trees, lamps, play equipment and street furniture
  D.instances('tree', raw.trees.map(([x, y]) => { const q = rng(hash(x, y)); return [x, BASE, -y, q() * 6.28, 0.75 + q() * 0.7, 0]; }));
  D.instances('lamp', raw.lamps.map(([x, y]) => [x, BASE, -y, rng(hash(x, y))() * 6.28, 1, 0]));
  D.instances('play', raw.play.map(([x, y]) => [x, 0.19, -y, rng(hash(x, y))() * 6.28, 1, 0]));
  const furn = {};
  for (const f of raw.furn) (furn[f.k] ||= []).push([f.x, 0.27, -f.y, rng(hash(f.x, f.y))() * 6.28, 1, 0]);
  for (const [k, l] of Object.entries(furn)) D.instances('furn:' + k, l);

  // collision, two 0.5 m bitmaps:
  //   coll: always blocks - buildings, water (unless a road or path crosses it), 1.8 m garden fences,
  //         tree trunks and lamp posts
  //   low:  blocks only on foot - hedges, which can be jumped over
  const bits = new Uint8Array(CN * CN / 8), low = new Uint8Array(CN * CN / 8);
  const post = (arr, x, y, r) => {   // a round obstacle; always marks at least its own cell
    const ring = Array.from({ length: 8 }, (_, k) => [x + r * Math.cos(k * Math.PI / 4), y + r * Math.sin(k * Math.PI / 4)]);
    rasterize(arr, [ring], 1);
    const c = Math.floor(x / CR), w = Math.floor(y / CR);
    if (c >= 0 && c < CN && w >= 0 && w < CN) { const bit = w * CN + c; arr[bit >> 3] |= 1 << (bit & 7); }
  };
  for (const w of raw.water) rasterize(bits, [w.p, ...w.holes], 1);
  for (const s of raw.surfaces) if (WALK_OVER_WATER.has(s.k)) rasterize(bits, [s.p, ...s.holes], 0);
  for (const b of buildings) rasterize(bits, [b.p], 1);
  for (const p of raw.blockers) rasterize(bits, [p], 1);
  for (const p of solidRects) rasterize(bits, [p], 1);
  for (const p of paths) rasterize(bits, [p], 0);
  for (const b of buildings) rasterize(bits, [b.p], 1);   // paths never open up a wall
  for (const [x, y] of raw.trees) post(bits, x, y, 0.35);
  for (const [x, y] of raw.lamps) post(bits, x, y, 0.12);
  for (const h of raw.hedges.flatMap(cutPaths)) rasterize(low, [h.p, ...(h.holes || [])], 1);
  for (const p of lowRects) rasterize(low, [p], 1);
  for (const p of paths) rasterize(low, [p], 0);           // paths through hedges stay open
  D.header.coll = D.add(bits);
  D.header.low = D.add(low);

  // labels for signs, the address pill and street names (square-local metres)
  D.header.meta = {
    pois: raw.pois.map(p => [p.n, p.k, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
    addr: raw.addr.filter(a => a.s).map(a => [a.s, a.n, Math.round(a.x), Math.round(a.y)]),
    streets: raw.streets.map(s => [s.n, s.p.filter((_, i) => i % 3 === 0 || i === s.p.length - 1).map(([x, y]) => [Math.round(x), Math.round(y)])]),
  };
  stats.d = D.write(path.join(outDir, key + '.d.bin'));
  return stats;
}

// ---------- main ----------
const args = process.argv.slice(2), slug = args[0];
const shard = (args[args.indexOf('--shard') + 1] || '0/1').split('/').map(Number);
const force = args.includes('--force');
const rawDir = path.join(HERE, 'data', slug, 'raw'), outDir = path.join(HERE, 'web', 'regions', slug, 't');
fs.mkdirSync(outDir, { recursive: true });
const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json')).sort().filter((_, i) => args.includes('--shard') ? i % shard[1] === shard[0] : true);
let n = 0;
for (const f of files) {
  const key = f.replace('.json', '');
  const src = path.join(rawDir, f), dst = path.join(outDir, key + '.d.bin');
  if (!force && fs.existsSync(dst) && fs.statSync(dst).mtimeMs > fs.statSync(src).mtimeMs) continue;
  const t0 = Date.now();
  try {
    const s = buildSquare(JSON.parse(fs.readFileSync(src, 'utf8')), outDir);
    console.log(`${key}: ${Date.now() - t0} ms, ${s.openings} openings, ${s.cars} cars, raw sizes b ${(s.b / 1e6).toFixed(1)} MB d ${(s.d / 1e6).toFixed(1)} MB f ${(s.f / 1e6).toFixed(1)} MB`);
  } catch (e) { console.log(`${key}: FAILED ${e.stack}`); }
  n++;
}
// tiles.json lists every square that has all three files
if (!args.includes('--shard')) {
  const sq = JSON.parse(fs.readFileSync(path.join(HERE, 'data', slug, 'squares.json'), 'utf8'));
  // keep what later steps added (overview); the build stamp makes browsers drop their cached copies
  const tj = path.join(HERE, 'web', 'regions', slug, 'tiles.json'), old = fs.existsSync(tj) ? JSON.parse(fs.readFileSync(tj, 'utf8')) : {};
  const have = sq.squares.filter(([i, j]) => ['b', 'd', 'f'].every(k => fs.existsSync(path.join(outDir, `${i}_${j}.${k}.bin`))));
  fs.writeFileSync(path.join(HERE, 'web', 'regions', slug, 'tiles.json'), JSON.stringify({ ...old, ...sq, squares: have, quant: { q: Q, ox: OX, oy: OY, oz: OZ }, build: Date.now().toString(36) }));
  console.log(`tiles.json: ${have.length} squares`);
}
