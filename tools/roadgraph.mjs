// Road network for the autopilot: every drivable OpenStreetMap way of a region as a small graph.
// Ways share nodes where they join, so a junction is simply a coordinate used by two ways.
// Output web/regions/<slug>/roads.json: { n: [x0, y0, x1, y1, ...] RD metres x2 (0.5 m), e: [a, b, flags, ...] }
// flags per segment a-b (in the way's drawing direction): 1 may drive a->b, 2 may drive b->a (one-way
// streets have only one), 4 cars allowed, 8 motorbikes allowed, and the speed limit in km/h from bit 4 on.
// Usage: node tools/roadgraph.mjs <slug>   (needs data/<slug>/osm.geojsonseq from tilebake.py)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
// cars may use these; cycle paths, footpaths and steps are left out
const DRIVE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'service', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road']);
// speed limit when the way has no maxspeed: the usual Dutch limit for that kind of road
const SPEED = { motorway: 100, trunk: 80, primary: 50, secondary: 50, tertiary: 50, unclassified: 50, residential: 30,
  living_street: 15, service: 15, road: 30 };
const NO = new Set(['no', 'private', 'agricultural', 'forestry', 'delivery']), YES = new Set(['yes', 'designated', 'destination', 'permissive']);
// may this vehicle use the way? The most specific tag wins: motorcar/motorcycle, then motor_vehicle, then access
function allowed(t, own) {
  for (const k of [own, 'motor_vehicle', 'vehicle', 'access']) { if (NO.has(t[k])) return false; if (YES.has(t[k])) return true; }
  return true;
}
// WGS84 -> RD, the same approximation as tilebake.py
function wgsToRd(lat, lon) {
  const p = 0.36 * (lat - 52.1551744), l = 0.36 * (lon - 5.38720621);
  const x = 190094.945 * l - 11832.228 * p * l - 114.221 * p * p * l - 32.391 * l ** 3 - 0.705 * p - 2.34 * p ** 3 * l - 0.608 * p * l ** 3 - 0.008 * l * l + 0.148 * p * p * l ** 3;
  const y = 309056.544 * p + 3638.893 * l * l + 73.077 * p * p - 157.984 * p * l * l + 59.788 * p ** 3 + 0.433 * l - 6.439 * p * p * l * l - 0.032 * p * l + 0.092 * l ** 4 - 0.054 * p * l ** 4;
  return [155000 + x, 463000 + y];
}
const sq = JSON.parse(fs.readFileSync(path.join(HERE, 'data', slug, 'squares.json'), 'utf8'));
const have = new Set(sq.squares.map(([i, j]) => i + '_' + j));
const id = new Map(), nodes = [], edges = [];
const node = (x, y) => { const k = Math.round(x * 2) + ',' + Math.round(y * 2); let n = id.get(k); if (n === undefined) { n = nodes.length / 2; id.set(k, n); nodes.push(Math.round(x * 2), Math.round(y * 2)); } return n; };
const rl = readline.createInterface({ input: fs.createReadStream(path.join(HERE, 'data', slug, 'osm.geojsonseq')) });
for await (let line of rl) {
  line = line.replace(/^\x1e/, ''); if (!line.includes('"highway"') || !line.includes('LineString')) continue;
  const f = JSON.parse(line), t = f.properties;
  if (f.geometry?.type !== 'LineString' || !DRIVE.has(t.highway)) continue;
  const car = allowed(t, 'motorcar'), bike = allowed(t, 'motorcycle');
  if (!car && !bike) continue;
  const kind = t.highway.replace('_link', '');
  const oneway = t.oneway === '-1' || t.oneway === 'reverse' ? 2
    : ['yes', 'true', '1'].includes(t.oneway) || (t.oneway !== 'no' && (kind === 'motorway' || ['roundabout', 'circular'].includes(t.junction))) ? 1 : 3;
  const kmh = Math.min(130, parseInt(t.maxspeed) || SPEED[kind] || 30);
  const flags = oneway | (car ? 4 : 0) | (bike ? 8 : 0) | kmh << 4;
  const pts = f.geometry.coordinates.map(([lo, la]) => wgsToRd(la, lo));
  // keep only the parts inside the region's squares
  let prev = null;
  for (const [x, y] of pts) {
    const inside = have.has(Math.floor(x / 500) + '_' + Math.floor(y / 500));
    const n = inside ? node(x, y) : null;
    if (n !== null && prev !== null && n !== prev) edges.push(prev, n, flags);
    prev = n;
  }
}
const out = path.join(HERE, 'web', 'regions', slug, 'roads.json');
fs.writeFileSync(out, JSON.stringify({ n: nodes, e: edges }));
console.log(`${slug}: ${nodes.length / 2} nodes, ${edges.length / 3} road segments, ${edges.filter((f, i) => i % 3 === 2 && (f & 3) !== 3).length} one-way, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
