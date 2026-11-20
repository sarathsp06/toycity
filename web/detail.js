// High-detail zone: draws block.detail (BGT surfaces, hedges, trees, lamp posts) and the
// 3D BAG buildings inside it: brick walls, aerial-photo roofs, doors and windows on the walls
// that face the street, parked cars, garden fences, street furniture and night lighting.
// Procedural textures are drawn on canvases at load time; only the aerial tiles are downloaded.
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const PX = 128; // texture pixels per metre

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)) >>> 0) / 4294967296; }
function hash(x, y) { return (Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(y * 10), 19349663)) >>> 0; }

function canvasTex(wm, hm, draw, renderer) {
  const c = document.createElement('canvas'); c.width = Math.round(wm * PX); c.height = Math.round(hm * PX);
  const g = c.getContext('2d'); draw(g, c.width, c.height);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.userData.size = [wm, hm];
  return t;
}
function speckle(g, w, h, n, colors, size = 2) {
  const r = rng(n);
  for (let i = 0; i < n; i++) { g.fillStyle = colors[Math.floor(r() * colors.length)]; g.fillRect(r() * w, r() * h, size, size); }
}

// one floor, 3 m wide: Dutch stretcher-bond brick (windows and doors are placed separately)
function wallTexture(renderer, base, dark, light) {
  return canvasTex(3, 2.8, (g, w, h) => {
    const r = rng(base.length * 99 + 7);
    g.fillStyle = '#cfc8bd'; g.fillRect(0, 0, w, h); // mortar
    const course = 0.0625 * PX, brick = 0.22 * PX;
    for (let row = 0, y = h - course; y > -course; row++, y -= course) {
      for (let x = (row % 2) * -brick / 2; x < w; x += brick) {
        const k = r(); g.fillStyle = k < 0.15 ? dark : k > 0.85 ? light : base;
        g.fillRect(x + 1, y + 1, brick - 2, course - 2);
      }
    }
  }, renderer);
}
function roofTiles(renderer, base, dark) {
  return canvasTex(1.2, 1.2, (g, w, h) => {
    const r = rng(base.charCodeAt(1) * 31);
    g.fillStyle = dark; g.fillRect(0, 0, w, h);
    const tw = 0.3 * PX, th = 0.2 * PX;
    for (let y = 0, row = 0; y < h; y += th, row++) for (let x = (row % 2) * tw / 2 - tw; x < w; x += tw) {
      const gr = g.createLinearGradient(x, 0, x + tw, 0);
      gr.addColorStop(0, dark); gr.addColorStop(0.45, base); gr.addColorStop(1, dark);
      g.fillStyle = gr; g.globalAlpha = 0.85 + r() * 0.15; g.fillRect(x + 1, y, tw - 2, th - 3);
    }
    g.globalAlpha = 1;
  }, renderer);
}
const surfaceTex = {
  road: r => canvasTex(4, 4, (g, w, h) => { g.fillStyle = '#5d6166'; g.fillRect(0, 0, w, h); speckle(g, w, h, 9000, ['#50545a', '#6a6e73', '#474b50', '#777b80']); }, r),
  brickroad: r => canvasTex(2, 2, (g, w, h) => { // herringbone clay pavers
    g.fillStyle = '#6e5a4d'; g.fillRect(0, 0, w, h); const q = rng(5), u = 0.105 * PX;
    for (let i = -20; i < 40; i++) for (let j = -20; j < 40; j++) {
      const x = (i - j) * u, y = (i + j) * u; const c = ['#8f4f3a', '#9a5a43', '#7d4433', '#a3644b'][Math.floor(q() * 4)];
      g.fillStyle = c; g.fillRect(x + 1, y + 1, 2 * u - 2, u - 2); g.fillRect(x + 2 * u + 1, y + 1 - u, u - 2, 2 * u - 2);
    } }, r),
  parking: r => canvasTex(2, 2, (g, w, h) => { g.fillStyle = '#6f6c68'; g.fillRect(0, 0, w, h); const q = rng(9), a = 0.21 * PX, b = 0.105 * PX;
    for (let y = 0, row = 0; y < h; y += b, row++) for (let x = (row % 2) * a / 2 - a; x < w; x += a) { g.fillStyle = ['#8a8782', '#7d7a75', '#94918b'][Math.floor(q() * 3)]; g.fillRect(x + 1, y + 1, a - 2, b - 2); } }, r),
  pavement: r => canvasTex(1.2, 1.2, (g, w, h) => { g.fillStyle = '#8f8d88'; g.fillRect(0, 0, w, h); const q = rng(3), s = 0.3 * PX;
    for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) { g.fillStyle = ['#b9b6ae', '#c2bfb7', '#b1aea6'][Math.floor(q() * 3)]; g.fillRect(x + 1.5, y + 1.5, s - 3, s - 3); }
    speckle(g, w, h, 1500, ['rgba(0,0,0,.08)', 'rgba(255,255,255,.12)']); }, r),
  cycle: r => canvasTex(4, 4, (g, w, h) => { g.fillStyle = '#9a4a3e'; g.fillRect(0, 0, w, h); speckle(g, w, h, 8000, ['#8a4136', '#a8564a', '#7e3a30']); }, r),
  grass: r => canvasTex(3, 3, (g, w, h) => { g.fillStyle = '#5f8f3e'; g.fillRect(0, 0, w, h); speckle(g, w, h, 30000, ['#6b9a46', '#557f36', '#78a652', '#4c7531', '#83ad5c'], 3); }, r),
  yard: r => canvasTex(3, 3, (g, w, h) => { g.fillStyle = '#6b9446'; g.fillRect(0, 0, w, h); speckle(g, w, h, 26000, ['#77a050', '#5d863d', '#86ad5f', '#8f8a6f'], 3); }, r),
  plants: r => canvasTex(2, 2, (g, w, h) => { g.fillStyle = '#2f5a2a'; g.fillRect(0, 0, w, h); const q = rng(4);
    for (let i = 0; i < 900; i++) { g.fillStyle = ['#3d6e33', '#28502a', '#4a7d3a', '#355f2c', '#6a8f45'][Math.floor(q() * 5)]; g.beginPath(); g.arc(q() * w, q() * h, 4 + q() * 9, 0, 6.3); g.fill(); } }, r),
  sand: r => canvasTex(2, 2, (g, w, h) => { g.fillStyle = '#d9c79f'; g.fillRect(0, 0, w, h); speckle(g, w, h, 9000, ['#cdb98f', '#e4d4ae', '#c4ae84']); }, r),
};
surfaceTex.paved = surfaceTex.pavement; surfaceTex.kerbisland = surfaceTex.pavement; surfaceTex.verge = surfaceTex.grass;
// top height of each surface kind; kerbs and planted beds are raised blocks
const TOP = { road: 0.15, brickroad: 0.15, parking: 0.16, cycle: 0.16, paved: 0.18, yard: 0.19, grass: 0.19, verge: 0.2, sand: 0.18, pavement: 0.27, kerbisland: 0.27, plants: 0.55 };
const BASE = 0.14;

function shapeFrom(poly, holes = []) {
  const s = new THREE.Shape(poly.map(p => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) s.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
  return s;
}
// extrude a footprint from y0 to y1 with world-space (metre) UVs on top and sides
function slab(rec, y0, y1) {
  const g = new THREE.ExtrudeGeometry(shapeFrom(rec.p, rec.holes || []), { depth: y1 - y0, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, x, z); else uv.setXY(i, x * Math.abs(nor.getZ(i)) + z * Math.abs(nor.getX(i)), y);
  }
  return g;
}
function windowTexture(renderer, lit) {
  return canvasTex(1.3, 1.35, (g, w, h) => {
    const f = 0.08 * PX, q = rng(lit ? 5 : 9);
    g.fillStyle = lit ? '#000' : '#f2f1ec'; g.fillRect(0, 0, w, h);
    const panes = [[f, f, w / 2 - f * 1.5, h - 2 * f], [w / 2 + f / 2, f, w / 2 - f * 1.5, h - 2 * f]];
    for (const [x, y, pw, ph] of panes) {
      if (lit) {
        const gl = g.createRadialGradient(x + pw / 2, y + ph * 0.6, 4, x + pw / 2, y + ph / 2, ph);
        gl.addColorStop(0, '#ffe2a8'); gl.addColorStop(1, '#c98a3c'); g.fillStyle = gl; g.fillRect(x, y, pw, ph);
        g.fillStyle = 'rgba(120,60,20,.5)'; g.fillRect(x, y, pw * 0.22, ph); // curtain
      } else {
        const sky = g.createLinearGradient(0, y, 0, y + ph);
        sky.addColorStop(0, '#a9c1d3'); sky.addColorStop(0.45, '#4d5e6d'); sky.addColorStop(1, '#262d34');
        g.fillStyle = sky; g.fillRect(x, y, pw, ph);
        g.fillStyle = 'rgba(255,255,255,.16)'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + pw * 0.45, y); g.lineTo(x, y + ph * 0.55); g.fill();
        if (q() < 0.5) { g.fillStyle = 'rgba(235,232,222,.55)'; g.fillRect(x, y, pw, ph * 0.18); } // net curtain
      }
    }
    if (!lit) { g.fillStyle = '#d9d6cc'; g.fillRect(0, h * 0.3, w, f * 0.5); g.fillStyle = '#3b3f44'; g.fillRect(-2, h - 6, w + 4, 6); }
  }, renderer);
}
function doorTexture(renderer) {
  return canvasTex(1.0, 2.2, (g, w, h) => {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, w, h);                         // tinted per house
    g.fillStyle = '#eeeeee'; g.fillRect(0, 0, w, 0.07 * PX); g.fillRect(0, 0, 0.07 * PX, h); g.fillRect(w - 0.07 * PX, 0, 0.07 * PX, h);
    g.fillStyle = '#9fb6c6'; g.fillRect(0.2 * PX, 0.15 * PX, w - 0.4 * PX, 0.55 * PX);   // glass
    g.strokeStyle = '#b4b4b4'; g.lineWidth = 3; g.strokeRect(0.2 * PX, 0.95 * PX, w - 0.4 * PX, 1.0 * PX);
    g.fillStyle = '#5a5a5a'; g.fillRect(0.3 * PX, 0.8 * PX, 0.4 * PX, 0.06 * PX);       // letterbox
    g.fillStyle = '#c9a54a'; g.beginPath(); g.arc(w - 0.18 * PX, 1.1 * PX, 5, 0, 6.3); g.fill(); // handle
  }, renderer);
}
function plankTexture(renderer) {
  return canvasTex(1.2, 1.8, (g, w, h) => {
    const q = rng(21), pw = 0.15 * PX;
    for (let x = 0; x < w; x += pw) { g.fillStyle = ['#7a5a3c', '#6d4f34', '#856343', '#715538'][Math.floor(q() * 4)]; g.fillRect(x, 0, pw - 2, h); g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x + pw - 2, 0, 2, h); }
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, 0.3 * PX, w, 6); g.fillRect(0, h - 0.35 * PX, w, 6);
  }, renderer);
}
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,214,150,1)'); gr.addColorStop(0.35, 'rgba(255,190,110,.45)'); gr.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function pip(x, y, poly) {
  let ok = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi) ok = !ok;
  }
  return ok;
}
// spatial index of polygons by bounding box, for "what is at this point" queries
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
// a simple low-poly car, 4.2 m long along local x
function carGeometries() {
  const body = BufferGeometryUtils.mergeGeometries([
    new THREE.BoxGeometry(4.2, 0.62, 1.74).translate(0, 0.62, 0),
    new THREE.BoxGeometry(0.9, 0.18, 1.7).translate(1.55, 0.98, 0),
  ]);
  const cabin = new THREE.CylinderGeometry(0.78, 0.98, 2.3, 4, 1).rotateY(Math.PI / 4).rotateZ(Math.PI / 2);
  cabin.scale(1, 0.38, 1.12).rotateX(0).translate(-0.25, 1.2, 0);
  const glass = new THREE.CylinderGeometry(0.8, 1.0, 2.25, 4, 1).rotateY(Math.PI / 4).rotateZ(Math.PI / 2).scale(1, 0.4, 1.13).translate(-0.25, 1.21, 0);
  const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 12).rotateX(Math.PI / 2);
  const wheels = BufferGeometryUtils.mergeGeometries([[1.35, 0.8], [1.35, -0.8], [-1.35, 0.8], [-1.35, -0.8]].map(([x, z]) => wheel.clone().translate(x, 0.33, z)));
  return { body: BufferGeometryUtils.mergeGeometries([body, cabin]), glass, wheels };
}
function material(tex, extra = {}) {
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0, ...extra });
}
// textures repeat per metre of world-space UV
function perMetre(t) { t.repeat.set(1 / t.userData.size[0], 1 / t.userData.size[1]); return t; }

export function buildDetail({ scene, renderer, block, baseUrl }) {
  const D = block.detail; if (!D) return { handled: new Set(), inZone: () => false, setNight() {}, solids: [] };
  const inZone = (x, y, pad = 0) => (x - D.c[0]) ** 2 + (y - D.c[1]) ** 2 < (D.r + pad) ** 2;
  const centroid = p => { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; };

  // ---- lookups: what is at a point (buildings first, then BGT surfaces) ----
  const zoneBuildings = block.buildings.filter(b => { const [x, y] = centroid(b.p); return inZone(x, y, 60); });
  const buildingAt = polyIndex(zoneBuildings);
  const surfaceAt = polyIndex(D.surfaces.filter(sf => { const [x, y] = centroid(sf.p); return inZone(x, y, 40); }));
  const kindAt = (x, y) => buildingAt(x, y) ? 'building' : (surfaceAt(x, y) || {}).k || null;
  const STREET = new Set(['road', 'brickroad', 'parking', 'pavement', 'cycle', 'kerbisland', 'verge']);
  const solids = []; // footprints that block walking, handed to the page for collision

  // ---- ground surfaces ----
  const byKind = {};
  for (const s of D.surfaces) {
    const [cx, cy] = centroid(s.p); if (!inZone(cx, cy)) continue;
    try { (byKind[s.k] ||= []).push(slab(s, BASE, TOP[s.k] ?? 0.18)); } catch {}
  }
  for (const [k, geos] of Object.entries(byKind)) {
    const tex = perMetre(surfaceTex[k](renderer));
    const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos), material(tex, { roughness: k === 'road' ? 0.8 : 0.95 }));
    m.receiveShadow = true; m.castShadow = k === 'plants'; scene.add(m);
  }

  // ---- hedges and garden walls ----
  {
    const hedge = [], wall = [];
    for (const h of D.hedges) { const [cx, cy] = centroid(h.p); if (inZone(cx, cy)) try { hedge.push(slab(h, BASE, 1.5)); solids.push(h.p); } catch {} }
    for (const h of D.walls) { const [cx, cy] = centroid(h.p); if (inZone(cx, cy)) try { wall.push(slab(h, BASE, 1.0)); } catch {} }
    if (hedge.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(hedge), material(perMetre(surfaceTex.plants(renderer)), { color: 0xb8d0a8 })); m.castShadow = m.receiveShadow = true; scene.add(m); }
    if (wall.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(wall), material(perMetre(wallTexture(renderer, '#8a4a36', '#6e3a2b', '#a35e48')))); m.castShadow = m.receiveShadow = true; scene.add(m); }
  }

  // ---- buildings with brick, windows and tiles ----
  const walls = [['#8a4a36', '#6e3a2b', '#a35e48'], ['#a8784f', '#8a603e', '#bf8f63'], ['#6b3e30', '#553026', '#7f4b3b'], ['#9b5b3f', '#7d4632', '#b06e50']]
    .map(c => wallTexture(renderer, ...c));
  const roofs = [roofTiles(renderer, '#4a4d52', '#2d2f33'), roofTiles(renderer, '#b5553a', '#7a3624'), roofTiles(renderer, '#5a3b33', '#3a2620')];
  const flatTex = canvasTex(4, 4, (g, w, h) => { g.fillStyle = '#6e6f70'; g.fillRect(0, 0, w, h); speckle(g, w, h, 12000, ['#5f6061', '#7d7e7f', '#8a8a86', '#56585a']); }, renderer);
  for (const t of walls) t.repeat.set(1, 1);
  const wallGeos = walls.map(() => []), roofGeos = roofs.map(() => []), flatGeos = [];
  // aerial photo tiles, projected straight down onto every roof that falls inside one
  const tiles = (D.aerial || []).map(t => {
    const tex = new THREE.TextureLoader().load(new URL(t.src, baseUrl).href);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return { ...t, tex, geos: [] };
  });
  const tileAt = (x, y) => tiles.find(t => x >= t.x0 && x < t.x1 && y >= t.y0 && y < t.y1);
  const wallFaces = [];
  const handled = new Set();
  const n = new THREE.Vector3(), t = new THREE.Vector3(), sd = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  block.buildings.forEach((bd, bi) => {
    if (!bd.m) return;
    const [cx, cy] = centroid(bd.p); if (!inZone(cx, cy)) return;
    handled.add(bi);
    const h = hash(cx, cy), m = bd.m;
    const V = k => [m.v[3 * k], m.v[3 * k + 2] + BASE, -m.v[3 * k + 1]];
    const out = { w: { pos: [], uv: [], col: [] }, r: { pos: [], uv: [], col: [] }, f: { pos: [], uv: [], col: [] } };
    const tile = tileAt(cx, cy);

    m.f.forEach((face, fi) => {
      const sem = m.s[fi]; if (sem === 0 || face.length < 3) return;
      const pts = face.map(V);
      n.set(0, 0, 0);
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; n.x += (p[1] - q[1]) * (p[2] + q[2]); n.y += (p[2] - q[2]) * (p[0] + q[0]); n.z += (p[0] - q[0]) * (p[1] + q[1]); }
      n.normalize();
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      const [u_, w_] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
      const tris = THREE.ShapeUtils.triangulateShape(pts.map(p => new THREE.Vector2(p[u_], p[w_])), []);
      let kind, uvOf;
      if (sem === 1 && tile) { kind = 'r'; uvOf = p => [(p[0] - tile.x0) / (tile.x1 - tile.x0), (-p[2] - tile.y0) / (tile.y1 - tile.y0)]; }
      else if (sem === 1 && ay > 0.97) { kind = 'f'; uvOf = p => [p[0] / 4, p[2] / 4]; }
      else if (sem === 1) {
        kind = 'r'; t.set(-n.z, 0, n.x).normalize(); sd.crossVectors(t, n).normalize();
        uvOf = p => [(p[0] * t.x + p[2] * t.z) / 1.2, (p[0] * sd.x + p[1] * sd.y + p[2] * sd.z) / 1.2];
      } else {
        kind = 'w'; t.set(-n.z, 0, n.x); if (t.lengthSq() < 1e-6) t.set(1, 0, 0); t.normalize();
        uvOf = p => [(p[0] * t.x + p[2] * t.z) / 3, (p[1] - BASE) / 2.8];
        wallFaces.push({ pts, n: n.clone(), bi, bd });
      }
      const o = out[kind];
      for (const tri of tris) {
        a.fromArray(pts[tri[0]]); b.fromArray(pts[tri[1]]); c.fromArray(pts[tri[2]]);
        const flip = c.sub(a).cross(b.sub(a)).dot(n) > 0;
        for (const k of (flip ? [tri[0], tri[2], tri[1]] : tri)) {
          const p = pts[k]; o.pos.push(...p); o.uv.push(...uvOf(p));
          // cheap ambient occlusion: walls darken toward the ground
          const s = kind === 'w' ? 0.72 + 0.28 * Math.min((p[1] - BASE) / 3, 1) : 1;
          o.col.push(s, s, s);
        }
      }
    });
    const mk = o => { if (!o.pos.length) return null; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(o.col, 3)); g.computeVertexNormals(); return g; };
    const gw = mk(out.w), gr = mk(out.r), gf = mk(out.f);
    const big = bd.kind === 'school' || bd.kind === 'apartments' || bd.h > 12;
    if (gw) wallGeos[big ? 1 : h % walls.length].push(gw);
    // older houses lean to clay tiles, newer ones to anthracite
    if (gr && tile) tile.geos.push(gr);
    else if (gr) roofGeos[bd.year && bd.year < 1970 ? 1 + ((h >>> 3) % 2) : (h >>> 3) % roofs.length].push(gr);
    if (gf) flatGeos.push(gf);
  });
  const add = (geos, mat) => { if (!geos.length) return; const ms = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos), mat); ms.castShadow = ms.receiveShadow = true; scene.add(ms); };
  walls.forEach((tx, i) => add(wallGeos[i], material(tx, { vertexColors: true, roughness: 0.85 })));
  roofs.forEach((tx, i) => add(roofGeos[i], material(tx, { roughness: 0.7 })));
  add(flatGeos, material(flatTex, { roughness: 0.95 }));
  for (const t of tiles) add(t.geos, material(t.tex, { roughness: 0.8 }));

  // ---- doors and windows: doors and full rows of windows on street-facing walls,
  //      windows on other open walls, nothing on party walls between houses ----
  const winDark = [], winLit = [], doors = [];
  {
    const doorWall = new Map(); // building index -> best street-facing wall
    for (const w of wallFaces) {
      const { pts, n: nn } = w;
      const tt = new THREE.Vector3(-nn.z, 0, nn.x).normalize();
      const S = p => p[0] * tt.x + p[2] * tt.z;
      const bottom = Math.min(...pts.map(p => p[1]));
      const low = pts.filter(p => p[1] < bottom + 0.4), high = pts.filter(p => p[1] > bottom + 1.8);
      if (low.length < 2 || !high.length) continue;
      const s0 = Math.min(...low.map(S)), s1 = Math.max(...low.map(S)), L = s1 - s0;
      const eave = Math.min(...high.map(p => p[1])), H = eave - bottom;
      if (L < 1.4 || H < 2.3) continue;
      const ref = low[0], sRef = S(ref);
      const at = (sv, y, out = 0) => [ref[0] + tt.x * (sv - sRef) + nn.x * out, y, ref[2] + tt.z * (sv - sRef) + nn.z * out];
      const mid = at((s0 + s1) / 2, bottom + 1, 0.8);
      if (kindAt(mid[0], -mid[2]) === 'building') continue;            // party wall
      let street = 0;
      for (let d = 1.5; d <= 16; d += 1.5) {
        const q = at((s0 + s1) / 2, 0, d), k = kindAt(q[0], -q[2]);
        if (k === 'building') break;
        if (STREET.has(k)) { street = d; break; }
      }
      w.L = L; w.s0 = s0; w.s1 = s1; w.bottom = bottom; w.eave = eave; w.at = at; w.street = street;
      if (street) { const cur = doorWall.get(w.bi); if (!cur || street < cur.street - 0.5 || (Math.abs(street - cur.street) <= 0.5 && L > cur.L)) doorWall.set(w.bi, w); }
    }
    const place = (list, w, sv, y, rot) => { const p = w.at(sv, y, 0.04); list.push([p, rot]); };
    for (const w of wallFaces) {
      if (w.L === undefined || (!w.street && w.L < 3)) continue;
      const rot = Math.atan2(w.n.x, w.n.z), q = rng(hash(w.s0 * 7, w.bottom * 13 + w.bi));
      const slots = Math.max(1, Math.floor((w.L - 0.4) / 2.6));
      const floors = Math.max(1, Math.floor((w.eave - w.bottom + 0.4) / 2.8));
      const doorSlot = doorWall.get(w.bi) === w ? Math.floor(q() * slots) : -1;
      for (let f = 0; f < floors; f++) for (let i = 0; i < slots; i++) {
        const sv = w.s0 + w.L * (i + 0.5) / slots, base = w.bottom + f * 2.8;
        if (f === 0 && i === doorSlot) { place(doors, w, sv, base + 1.1, rot); continue; }
        if (!w.street && q() < 0.35) continue;                          // fewer windows on back and side walls
        if (base + 2.3 > w.eave - 0.1) continue;
        place(q() < 0.3 ? winLit : winDark, w, sv, base + 1.55, rot);
      }
    }
  }
  const quad = (w, h) => new THREE.PlaneGeometry(w, h);
  const inst = (geo, mat, list, colorOf) => {
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(geo, mat, list.length), o = new THREE.Object3D(), col = new THREE.Color();
    list.forEach(([p, rot], k) => { o.position.set(...p); o.rotation.set(0, rot, 0); o.updateMatrix(); m.setMatrixAt(k, o.matrix); if (colorOf) m.setColorAt(k, colorOf(k, col)); });
    m.receiveShadow = true; scene.add(m); return m;
  };
  const glassTex = windowTexture(renderer, false), litTex = windowTexture(renderer, true);
  glassTex.repeat.set(1, 1); litTex.repeat.set(1, 1);
  inst(quad(1.3, 1.35), material(glassTex, { roughness: 0.25, metalness: 0.1 }), winDark);
  const litMat = material(glassTex, { roughness: 0.25, emissiveMap: litTex, emissive: 0xffffff, emissiveIntensity: 0 });
  inst(quad(1.3, 1.35), litMat, winLit);
  const doorTex = doorTexture(renderer); doorTex.repeat.set(1, 1);
  const DOOR = [0x2e4a3a, 0x23314a, 0x1e1f22, 0x6b4a2f, 0xe8e6df, 0x7a2a26, 0x3d5a6b];
  inst(quad(1.0, 2.2), material(doorTex, { roughness: 0.6 }), doors, (k, c) => c.setHex(DOOR[hash(doors[k][0][0], doors[k][0][2]) % DOOR.length]));

  // ---- parked cars in the BGT parking bays ----
  const cars = [];
  for (const sf of D.surfaces) {
    if (sf.k !== 'parking') continue;
    const [cx, cy] = centroid(sf.p); if (!inZone(cx, cy)) continue;
    let best = 0, ux = 1, uy = 0;
    for (let i = 0; i + 1 < sf.p.length; i++) { const dx = sf.p[i + 1][0] - sf.p[i][0], dy = sf.p[i + 1][1] - sf.p[i][1], l = Math.hypot(dx, dy); if (l > best) { best = l; ux = dx / l; uy = dy / l; } }
    const vx = -uy, vy = ux;
    const U = sf.p.map(p => p[0] * ux + p[1] * uy), V = sf.p.map(p => p[0] * vx + p[1] * vy);
    const u0 = Math.min(...U), u1 = Math.max(...U), v0 = Math.min(...V), v1 = Math.max(...V), W = v1 - v0;
    const parallel = W < 3.6, step = parallel ? 6 : 2.5, rows = parallel ? 1 : Math.max(1, Math.floor(W / 5));
    for (let r = 0; r < rows; r++) for (let u = u0 + step / 2; u < u1 - step / 2 + 0.01; u += step) {
      const v = v0 + W * (r + 0.5) / rows, x = u * ux + v * vx, y = u * uy + v * vy;
      const hx = parallel ? ux : vx, hy = parallel ? uy : vy;
      if (![0, 1.7, -1.7].every(k => pip(x + hx * k, y + hy * k, sf.p))) continue;
      const q = rng(hash(x, y)); if (q() > 0.72) continue;
      const flip = q() < 0.5 ? Math.PI : 0;
      cars.push([[x, 0.17, -y], Math.atan2(hy, hx) + flip, q]);
    }
  }
  if (cars.length) {
    const g = carGeometries(), o = new THREE.Object3D(), col = new THREE.Color();
    const PAINT = [0xf2f2f2, 0x1c1c1e, 0x8a8f96, 0xc4c7cc, 0x24365c, 0x8c1c1c, 0x3f4a3c, 0xe8e2d0];
    const bm = new THREE.InstancedMesh(g.body, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 }), cars.length);
    const gm = new THREE.InstancedMesh(g.glass, new THREE.MeshStandardMaterial({ color: 0x1d2730, roughness: 0.1, metalness: 0.6 }), cars.length);
    const wm = new THREE.InstancedMesh(g.wheels, new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }), cars.length);
    cars.forEach(([p, rot, q], k) => {
      o.position.set(...p); o.rotation.set(0, rot, 0); o.updateMatrix();
      bm.setMatrixAt(k, o.matrix); gm.setMatrixAt(k, o.matrix); wm.setMatrixAt(k, o.matrix);
      bm.setColorAt(k, col.setHex(PAINT[Math.floor(q() * PAINT.length)]));
    });
    for (const m of [bm, gm, wm]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
  }

  // ---- garden boundaries: no fence data is mapped here, so they are derived from the BGT plots:
  //      a low hedge where a garden meets the street, a 1.8 m wooden fence between gardens ----
  {
    const fence = [], hedge = [], seen = new Set();
    for (const sf of D.surfaces) {
      if (sf.k !== 'yard') continue;
      const [cx, cy] = centroid(sf.p); if (!inZone(cx, cy)) continue;
      let A = 0; for (let i = 0, j = sf.p.length - 1; i < sf.p.length; j = i++) A += sf.p[j][0] * sf.p[i][1] - sf.p[i][0] * sf.p[j][1];
      const sgn = A > 0 ? 1 : -1;
      for (let i = 0; i + 1 < sf.p.length; i++) {
        const [ax, ay] = sf.p[i], [bx, by] = sf.p[i + 1], dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
        if (l < 0.8) continue;
        const nx = sgn * dy / l, ny = -sgn * dx / l, mx = (ax + bx) / 2, my = (ay + by) / 2;
        const key = Math.round(mx * 2) + ',' + Math.round(my * 2); if (seen.has(key)) continue; seen.add(key);
        const k = kindAt(mx + nx * 0.6, my + ny * 0.6);
        if (k === 'building' || kindAt(mx - nx * 0.6, my - ny * 0.6) === 'building') continue;
        const front = STREET.has(k), th = front ? 0.3 : 0.03;
        const rect = { p: [[ax - nx * th, ay - ny * th], [bx - nx * th, by - ny * th], [bx + nx * th, by + ny * th], [ax + nx * th, ay + ny * th], [ax - nx * th, ay - ny * th]] };
        try { (front ? hedge : fence).push(slab(rect, BASE, front ? 0.95 : 1.8)); solids.push(rect.p); } catch {}
      }
    }
    if (fence.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(fence), material(perMetre(plankTexture(renderer)), { side: THREE.DoubleSide })); m.castShadow = m.receiveShadow = true; scene.add(m); }
    if (hedge.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(hedge), material(perMetre(surfaceTex.plants(renderer)), { color: 0xc0d8b0 })); m.castShadow = m.receiveShadow = true; scene.add(m); }
  }

  // ---- street furniture from OpenStreetMap ----
  {
    const parts = {
      bollard: [new THREE.CylinderGeometry(0.08, 0.1, 0.9, 10).translate(0, 0.45, 0), 0x2b2d30],
      bin: [new THREE.CylinderGeometry(0.28, 0.26, 0.95, 14).translate(0, 0.48, 0), 0x3b5a46],
      postbox: [new THREE.BoxGeometry(0.5, 1.2, 0.4).translate(0, 0.6, 0), 0xe06a1b],
      charger: [new THREE.BoxGeometry(0.45, 1.4, 0.3).translate(0, 0.7, 0), 0x2f8f5b],
      bench: [BufferGeometryUtils.mergeGeometries([new THREE.BoxGeometry(1.8, 0.08, 0.45).translate(0, 0.45, 0), new THREE.BoxGeometry(1.8, 0.4, 0.06).translate(0, 0.75, -0.2), new THREE.BoxGeometry(0.08, 0.45, 0.4).translate(-0.8, 0.22, 0), new THREE.BoxGeometry(0.08, 0.45, 0.4).translate(0.8, 0.22, 0)]), 0x6b4a2f],
      bikerack: [BufferGeometryUtils.mergeGeometries([-1.2, -0.4, 0.4, 1.2].map(x => new THREE.TorusGeometry(0.4, 0.03, 6, 16, Math.PI).translate(x, 0.25, 0))), 0x9aa0a6],
      busstop: [BufferGeometryUtils.mergeGeometries([new THREE.BoxGeometry(3.4, 0.1, 1.5).translate(0, 2.5, 0), new THREE.BoxGeometry(3.4, 2.3, 0.05).translate(0, 1.25, -0.7), new THREE.BoxGeometry(0.05, 2.3, 1.4).translate(-1.7, 1.25, 0)]), 0x8fa3ad],
    };
    const byK = {};
    for (const f of block.furniture || []) if (parts[f.k] && inZone(f.x, f.y)) (byK[f.k] ||= []).push(f);
    for (const [k, list] of Object.entries(byK)) {
      const m = new THREE.InstancedMesh(parts[k][0], new THREE.MeshStandardMaterial({ color: parts[k][1], roughness: 0.6, metalness: k === 'busstop' || k === 'bikerack' ? 0.4 : 0.1, transparent: k === 'busstop', opacity: k === 'busstop' ? 0.75 : 1 }), list.length);
      const o = new THREE.Object3D();
      list.forEach((f, i) => { o.position.set(f.x, 0.27, -f.y); o.rotation.y = rng(hash(f.x, f.y))() * 6.28; o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
      m.castShadow = true; scene.add(m);
    }
  }

  // ---- trees: trunk plus a cluster of lumpy crowns, sized per tree ----
  const trees = D.trees.filter(p => inZone(p[0], p[1]));
  if (trees.length) {
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 3.2, 7); trunk.translate(0, 1.6, 0);
    const parts = [], r = rng(11);
    for (const [ox, oy, oz, rad] of [[0, 4.6, 0, 1.9], [0.9, 4.0, 0.5, 1.4], [-0.8, 4.1, -0.4, 1.5], [0.2, 5.6, -0.3, 1.3], [-0.3, 3.8, 0.9, 1.2]]) {
      const g = new THREE.IcosahedronGeometry(rad, 2); const p = g.attributes.position; const seed = r() * 100;
      // displace by a smooth function of the original direction, so shared corners stay joined
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const k = 0.88 + 0.12 * Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 - seed) + 0.06 * Math.sin(y * 4.3 + seed * 2);
        p.setXYZ(i, x * k + ox, y * k * 0.9 + oy, z * k + oz);
      }
      parts.push(g);
    }
    const crown = BufferGeometryUtils.mergeVertices(BufferGeometryUtils.mergeGeometries(parts.map(g => g.deleteAttribute('uv') || g)));
    crown.computeVertexNormals();
    const tm = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 }), trees.length);
    const cm = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), trees.length);
    const o = new THREE.Object3D(), col = new THREE.Color();
    trees.forEach((p, k) => {
      const q = rng(hash(p[0], p[1])); const s = 0.75 + q() * 0.7;
      o.position.set(p[0], BASE, -p[1]); o.rotation.y = q() * 6.28; o.scale.set(s, s * (0.9 + q() * 0.3), s); o.updateMatrix();
      tm.setMatrixAt(k, o.matrix); cm.setMatrixAt(k, o.matrix);
      cm.setColorAt(k, col.setHSL(0.25 + q() * 0.07, 0.45 + q() * 0.15, 0.17 + q() * 0.07));
    });
    tm.castShadow = cm.castShadow = true; cm.receiveShadow = true; scene.add(tm, cm);
  }

  // ---- lamp posts ----
  let headMat = null, poolMat = null, pools = null;
  const lamps = D.lamps.filter(p => inZone(p[0], p[1]));
  if (lamps.length) {
    const pole = new THREE.CylinderGeometry(0.06, 0.09, 6, 8); pole.translate(0, 3, 0);
    const head = new THREE.BoxGeometry(0.22, 0.12, 0.55); head.translate(0, 6, 0.2);
    const pm = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x3c4146, roughness: 0.5, metalness: 0.6 }), lamps.length);
    headMat = new THREE.MeshStandardMaterial({ color: 0x3c4146, emissive: 0xffd49a, emissiveIntensity: 0, roughness: 0.4 });
    const hm = new THREE.InstancedMesh(head, headMat, lamps.length);
    const pool = new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2);
    poolMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    pools = new THREE.InstancedMesh(pool, poolMat, lamps.length); pools.renderOrder = 2; pools.visible = false;
    const o = new THREE.Object3D(), o2 = new THREE.Object3D();
    lamps.forEach((p, k) => {
      o.position.set(p[0], BASE, -p[1]); o.rotation.y = rng(hash(p[0], p[1]))() * 6.28; o.updateMatrix();
      pm.setMatrixAt(k, o.matrix); hm.setMatrixAt(k, o.matrix);
      o2.position.set(p[0], 0.32, -p[1]); o2.updateMatrix(); pools.setMatrixAt(k, o2.matrix);
    });
    pm.castShadow = true; scene.add(pm, hm, pools);
  }
  // 0 = daylight, 1 = full night: street lamps and some windows light up
  function setNight(k) {
    litMat.emissiveIntensity = 1.3 * k;
    if (headMat) headMat.emissiveIntensity = 4 * k;
    if (pools) { pools.visible = k > 0.02; poolMat.opacity = 0.75 * k; }
  }
  return { handled, inZone, solids, setNight, trees: trees.length, lamps: lamps.length, cars: cars.length, doors: doors.length, windows: winDark.length + winLit.length };
}
