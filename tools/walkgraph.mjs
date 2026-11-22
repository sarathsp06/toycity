// Walking network for finding someone on foot: footpaths, pavements, crossings, squares and steps from
// OpenStreetMap, plus the streets themselves with which side their pavement is on, so a walking route
// keeps off the carriageway. Separate from roads.json (cars), which has none of the footpaths.
// Output web/regions/<slug>/walks.json: { n: [x0, y0, x1, y1, ...] RD metres x2 (0.5 m), e: [a, b, w, ...] }
// w per segment a-b (both directions are walkable):
//   bits 0-1  where to draw it: 0 on the line itself (a footpath), 1 pavement on the right of a->b,
//             2 on the left, 3 on both sides (the walker keeps right)
//   bits 2-7  how far the pavement is from the street's centre line, in 0.25 m
//   bits 8-10 cost class: 0 footpath, 1 street with a pavement, 2 street, pavement not mapped,
//             3 street without one (or with its pavement mapped as a separate footpath), 4 steps
// Usage: node tools/walkgraph.mjs <slug>   (needs data/<slug>/osm.geojsonseq from tilebake.py)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
const PATHS = new Set(['footway', 'pedestrian', 'path', 'steps', 'track', 'living_street']);
// streets you may walk along, and half their usual width when the way does not say
const STREETS = { primary: 6, secondary: 5, tertiary: 4.5, unclassified: 3.5, residential: 3.2, service: 2.2, road: 3.2 };
const NO = new Set(['no', 'private']), YES = new Set(['yes', 'designated', 'permissive', 'destination']);
function wgsToRd(lat, lon) {   // the same approximation as roadgraph.mjs and tilebake.py
  const p = 0.36 * (lat - 52.1551744), l = 0.36 * (lon - 5.38720621);
  const x = 190094.945 * l - 11832.228 * p * l - 114.221 * p * p * l - 32.391 * l ** 3 - 0.705 * p - 2.34 * p ** 3 * l - 0.608 * p * l ** 3 - 0.008 * l * l + 0.148 * p * p * l ** 3;
  const y = 309056.544 * p + 3638.893 * l * l + 73.077 * p * p - 157.984 * p * l * l + 59.788 * p ** 3 + 0.433 * l - 6.439 * p * p * l * l - 0.032 * p * l + 0.092 * l ** 4 - 0.054 * p * l ** 4;
  return [155000 + x, 463000 + y];
}
// which sides have a pavement: 'both' | 'left' | 'right' | 'none' | 'separate' | undefined (not mapped)
function sidewalk(t) {
  const s = t.sidewalk || t.footway;
  if (s === 'both' || s === 'yes') return 'both';
  if (s === 'left' || s === 'right') return s;
  if (s === 'no' || s === 'none') return 'none';
  if (s === 'separate') return 'separate';
  const b = t['sidewalk:both'], l = t['sidewalk:left'], r = t['sidewalk:right'];
  if (b === 'separate' || l === 'separate' || r === 'separate') return 'separate';
  if (b === 'yes' || (l === 'yes' && r === 'yes')) return 'both';
  if (l === 'yes') return 'left'; if (r === 'yes') return 'right';
  if (b === 'no' || (l === 'no' && r === 'no')) return 'none';
  return undefined;
}
const sq = JSON.parse(fs.readFileSync(path.join(HERE, 'data', slug, 'squares.json'), 'utf8'));
const have = new Set(sq.squares.map(([i, j]) => i + '_' + j));
const id = new Map(), nodes = [], edges = [];
const node = (x, y) => { const k = Math.round(x * 2) + ',' + Math.round(y * 2); let n = id.get(k); if (n === undefined) { n = nodes.length / 2; id.set(k, n); nodes.push(Math.round(x * 2), Math.round(y * 2)); } return n; };
const count = { path: 0, street: 0 };
const rl = readline.createInterface({ input: fs.createReadStream(path.join(HERE, 'data', slug, 'osm.geojsonseq')) });
for await (let line of rl) {
  line = line.replace(/^\x1e/, ''); if (!line.includes('"highway"') || !line.includes('LineString')) continue;
  const f = JSON.parse(line), t = f.properties;
  if (f.geometry?.type !== 'LineString') continue;
  const hw = t.highway, kind = String(hw || '').replace('_link', '');
  if (NO.has(t.foot) || (NO.has(t.access) && !YES.has(t.foot)) || t.indoor === 'yes') continue;
  let w;
  if (PATHS.has(hw) || (hw === 'cycleway' && YES.has(t.foot))) {
    w = (hw === 'steps' ? 4 : 0) << 8; count.path++;
  } else if (STREETS[kind] !== undefined) {
    const side = sidewalk(t);
    const half = Math.min(10, parseFloat(t.width) / 2 || (parseInt(t.lanes) ? parseInt(t.lanes) * 1.6 + 0.4 : STREETS[kind]));
    const off = Math.min(63, Math.round((half + 1.5) * 4));
    const bits = side === 'left' ? 2 : side === 'right' ? 1 : side === 'none' || side === 'separate' ? 0 : 3;
    const cls = side === 'both' || side === 'left' || side === 'right' ? 1 : side === undefined ? (kind === 'primary' || kind === 'secondary' ? 3 : 2) : 3;
    w = bits | off << 2 | cls << 8; count.street++;
  } else if (YES.has(t.foot) && hw) {   // anything else explicitly open to walkers (a cycle path that allows it, a bridge)
    w = 0; count.path++;
  } else continue;
  const pts = f.geometry.coordinates.map(([lo, la]) => wgsToRd(la, lo));
  let prev = null;
  for (const [x, y] of pts) {
    const inside = have.has(Math.floor(x / 500) + '_' + Math.floor(y / 500));
    const n = inside ? node(x, y) : null;
    if (n !== null && prev !== null && n !== prev) edges.push(prev, n, w);
    prev = n;
  }
}
const out = path.join(HERE, 'web', 'regions', slug, 'walks.json');
fs.writeFileSync(out, JSON.stringify({ n: nodes, e: edges }));
console.log(slug, nodes.length / 2, 'nodes', edges.length / 3, 'segments', count, (fs.statSync(out).size / 1e6).toFixed(1) + ' MB');
