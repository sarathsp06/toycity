// Step 3 of the square pipeline: the coarse level of the quadtree. One overview file covers 2 km x 2 km
// (4 x 4 squares) and is shown wherever the 500 m squares have not loaded yet, and out to the horizon.
//
// Usage: node tools/overview.mjs SLUG          (run after buildtiles.mjs; the aerial mosaics come from
//        tools/.venv/bin/python tools/overview_aerial.py SLUG)
// Writes web/regions/<slug>/o/OI_OJ.bin and adds "overview" to tiles.json.
//
// Buildings are merged into blocks: footprints of similar height are unioned per square, so a row of
// terraced houses becomes one block, then simplified to 1.5 m. Flat roofs only; roofs take their colour
// from the aerial photo in the page. Every vertex carries its square (0..15), so the page can hide the
// part of the overview that a loaded square already covers, in one draw call.
//
// File format: the usual gzip header + blob. header = { count, index: [off, len], pos: [off, len],
// nrm: [off, len] }; pos is Uint16 at 5 cm in overview-local space plus a 100 m margin
// (x = east + 100, y up, z = 2000 - north + 100),
// nrm is Int8 x, y, z plus the square number.
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pc from 'polygon-clipping';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = 500, N = 4, S = T * N, Q = 0.05, M = 100, MIN_AREA = 12, TOL = 1.5, BIN = 3;

function simplify(ring, tol) {
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
  return ring.filter((_, i) => keep[i]);
}
const area = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };
const open = r => (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]) ? r.slice(0, -1) : r;

function buildOverview(oi, oj, squares, rawDir) {
  const pos = [], nrm = [], index = [];
  const vert = (x, y, z, nx, ny, nz, sq) => {
    pos.push(Math.round((x + M) / Q), Math.round(y / Q), Math.round((z + M) / Q));   // buildings may stick out of the tile a little
    nrm.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127), sq);
    return pos.length / 3 - 1;
  };
  let blocks = 0, buildings = 0;
  for (const [i, j] of squares) {
    const raw = JSON.parse(fs.readFileSync(path.join(rawDir, `${i}_${j}.json`), 'utf8'));
    const sq = (i - oi * N) + (j - oj * N) * N, ox = (i - oi * N) * T, oy = (j - oj * N) * T;
    // group footprints by rounded height, then union each group
    const bins = new Map();
    for (const b of raw.buildings) {
      const ring = open(b.p);
      if (ring.length < 3 || Math.abs(area(ring)) < MIN_AREA) continue;
      const h = Math.max(BIN, Math.round((b.h || 6) / BIN) * BIN);
      (bins.get(h) || bins.set(h, []).get(h)).push([[...ring, ring[0]]]);
      buildings++;
    }
    for (const [h, polys] of bins) {
      let merged;
      try { merged = pc.union(...polys); } catch { merged = polys; }
      for (const poly of merged) {
        let outer = simplify(open(poly[0]), TOL);
        if (outer.length < 3 || Math.abs(area(outer)) < MIN_AREA) continue;
        const holes = poly.slice(1).map(r => simplify(open(r), TOL)).filter(r => r.length >= 3 && Math.abs(area(r)) > 20);
        if (area(outer) < 0) outer.reverse();
        holes.forEach(r => { if (area(r) > 0) r.reverse(); });
        blocks++;
        // walls: one quad per edge, outward normal (outer is counter-clockwise in east/north)
        for (const ring of [outer, ...holes]) {
          for (let k = 0; k < ring.length; k++) {
            const [x0, y0] = ring[k], [x1, y1] = ring[(k + 1) % ring.length];
            const L = Math.hypot(x1 - x0, y1 - y0); if (L < 0.3) continue;
            const nx = (y1 - y0) / L, nz = (x1 - x0) / L;   // east/north normal (dy, -dx) -> three.js z = -north
            const a = vert(ox + x0, 0, S - (oy + y0), nx, 0, nz, sq), b = vert(ox + x1, 0, S - (oy + y1), nx, 0, nz, sq);
            const c = vert(ox + x1, h, S - (oy + y1), nx, 0, nz, sq), d = vert(ox + x0, h, S - (oy + y0), nx, 0, nz, sq);
            index.push(a, b, c, a, c, d);
          }
        }
        // flat roof
        const tris = THREE.ShapeUtils.triangulateShape(outer.map(([x, y]) => new THREE.Vector2(x, y)), holes.map(r => r.map(([x, y]) => new THREE.Vector2(x, y))));
        const all = [...outer, ...holes.flat()], base = pos.length / 3;
        for (const [x, y] of all) vert(ox + x, h, S - (oy + y), 0, 1, 0, sq);
        // counter-clockwise in east/north is counter-clockwise seen from above, so it faces up
        for (const [a, b, c] of tris) {
          const [ax, ay] = all[a], [bx, by] = all[b], [cx, cy] = all[c];
          if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0) index.push(base + a, base + b, base + c); else index.push(base + a, base + c, base + b);
        }
      }
    }
  }
  return { pos: Uint16Array.from(pos), nrm: Int8Array.from(nrm), index: pos.length / 3 > 65535 ? Uint32Array.from(index) : Uint16Array.from(index), blocks, buildings };
}

function write(file, { pos, nrm, index }) {
  const parts = [], header = { count: pos.length / 3 };
  let size = 0;
  for (const [k, a] of [['index', index], ['pos', pos], ['nrm', nrm]]) {
    const pad = (4 - (size % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); size += pad; }
    header[k] = [size, a.length, a.constructor.name];
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength); parts.push(b); size += b.length;
  }
  let hj = Buffer.from(JSON.stringify(header));
  hj = Buffer.concat([hj, Buffer.alloc((4 - ((4 + hj.length) % 4)) % 4, 32)]);
  const len = Buffer.alloc(4); len.writeUInt32LE(hj.length);
  const out = zlib.gzipSync(Buffer.concat([len, hj, ...parts]), { level: 9 });
  fs.writeFileSync(file, out);
  return out.length;
}

const slug = process.argv[2];
const web = path.join(HERE, 'web', 'regions', slug), rawDir = path.join(HERE, 'data', slug, 'raw');
const info = JSON.parse(fs.readFileSync(path.join(web, 'tiles.json'), 'utf8'));
const groups = new Map();
for (const [i, j] of info.squares) { const k = Math.floor(i / N) + '_' + Math.floor(j / N); (groups.get(k) || groups.set(k, []).get(k)).push([i, j]); }
fs.mkdirSync(path.join(web, 'o'), { recursive: true });
const list = [];
for (const [k, squares] of groups) {
  const [oi, oj] = k.split('_').map(Number), t0 = Date.now();
  const r = buildOverview(oi, oj, squares, rawDir);
  const bytes = write(path.join(web, 'o', k + '.bin'), r);
  list.push([oi, oj]);
  console.log(`${k}: ${squares.length} squares, ${r.buildings} buildings -> ${r.blocks} blocks, ${r.index.length / 3} triangles, ${(bytes / 1e3).toFixed(0)} kB, ${Date.now() - t0} ms`);
}
info.overview = { size: S, n: N, q: Q, margin: M, tiles: list };
info.build = Date.now().toString(36);   // new bake, new browser cache
fs.writeFileSync(path.join(web, 'tiles.json'), JSON.stringify(info));
