// Solid things you bump into: one list of footprints and one test, whatever the thing is.
// Buildings, walls, water and hedges come from each square's baked collision bitmap (city.js);
// everything else lives here: parked cars, trees, lamp posts and street furniture from the squares,
// and moving things such as other players. Each footprint is a circle { x, z, r } or a box turned
// by `yaw` { x, z, hx, hz, yaw }, in world metres on the ground.
//
//   const solids = createSolids();
//   solids.add(owner, [footprints])    static things, e.g. the cars of one square
//   solids.drop(owner)                 when that square unloads
//   solids.live(fn)                    fn() returns footprints that move (asked once per frame)
//   solids.beginFrame()                once per animation frame: the live footprints are asked again
//   solids.hit(x, z, r)                does a circle of radius r at (x, z) touch anything solid?
//   solids.hitStatic(x, z, r)          the same for the static things only (no allocation)
//   solids.at(x, z, r)                 the static footprints that circle touches

// footprint of each kind of placed object, by its instance name, for a scale of 1
export const FOOTPRINTS = {
  car: { hx: 2.15, hz: 0.88 },        // length along the car, width across
  tree: { r: 0.3 },                   // the trunk (you walk under the crown)
  lamp: { r: 0.15 },
  'furn:bollard': { r: 0.12 },
  'furn:bench': { hx: 0.9, hz: 0.25 },
  'furn:bin': { r: 0.3 },
  'furn:postbox': { r: 0.3 },
  'furn:busstop': { hx: 1.6, hz: 0.7 },
};
export const PERSON = { r: 0.3 };

const CELL = 8;
const cellOf = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);

export function hits(f, x, z, r) {
  if (f.off) return false;   // switched off, e.g. a parked car someone is driving
  const dx = x - f.x, dz = z - f.z;
  if (f.r !== undefined) return dx * dx + dz * dz < (f.r + r) ** 2;
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);   // into the object's own frame (three.js y rotation)
  return Math.abs(dx * c - dz * s) < f.hx + r && Math.abs(dx * s + dz * c) < f.hz + r;
}

// footprints of instanced objects: data is [x, y, z, yaw, scale, colour] per object, local to `origin`
export function footprintsOf(name, data, origin) {
  const fp = FOOTPRINTS[name]; if (!fp) return [];
  const out = [];
  for (let k = 0; k < data.length; k += 6) {
    const x = data[k] + origin.x, z = data[k + 2] + origin.z, sc = name === 'car' ? 1 : data[k + 4] || 1;
    out.push(fp.r !== undefined ? { x, z, r: fp.r * sc } : { x, z, hx: fp.hx * sc, hz: fp.hz * sc, yaw: data[k + 3] });
  }
  return out;
}

// a footprint is filed in every grid cell within its reach plus the largest query radius (hit(x, z, r)
// looks in the cell of (x, z) only), so a car just across a cell border still blocks
const SLACK = 0.35;
export function createSolids() {
  const grid = new Map(), owned = new Map(), live = [];
  const reach = f => (f.r ?? Math.hypot(f.hx, f.hz)) + SLACK;
  function cells(f, each) {
    const e = reach(f);
    for (let i = Math.floor((f.x - e) / CELL); i <= Math.floor((f.x + e) / CELL); i++)
      for (let j = Math.floor((f.z - e) / CELL); j <= Math.floor((f.z + e) / CELL); j++) each(i + ',' + j);
  }
  function drop(owner) {
    for (const f of owned.get(owner) || []) cells(f, k => { const a = grid.get(k); const i = a ? a.indexOf(f) : -1; if (i >= 0) a.splice(i, 1); });
    owned.delete(owner);
  }
  function add(owner, list) {
    if (!list.length) return;
    owned.set(owner, [...(owned.get(owner) || []), ...list]);
    for (const f of list) cells(f, k => (grid.get(k) || grid.set(k, []).get(k)).push(f));
  }
  // the moving footprints, asked of the live functions once per frame (many tests share a frame);
  // without beginFrame() ever called (tests, tools) they are asked on every test as before
  let frame = 0, cacheFrame = -1, liveFps = [];
  function beginFrame() { frame++; }
  function moving() {
    if (frame && cacheFrame === frame) return liveFps;
    cacheFrame = frame; liveFps = [];
    for (const fn of live) for (const f of fn()) liveFps.push(f);
    return liveFps;
  }
  function hit(x, z, r) {
    for (const f of grid.get(cellOf(x, z)) || []) if (hits(f, x, z, r)) return true;
    for (const f of moving()) if (!(f.id && ignore.has(f.id)) && hits(f, x, z, r)) return true;
    return false;
  }
  // the static things only (no people, no moving cars): does a circle touch one, and which ones
  function hitStatic(x, z, r) {
    for (const f of grid.get(cellOf(x, z)) || []) if (hits(f, x, z, r)) return true;
    return false;
  }
  function at(x, z, r) { return (grid.get(cellOf(x, z)) || []).filter(f => hits(f, x, z, r)); }
  // people (live footprints with an id) that are not solid for now: someone knocked over a moment ago
  const ignore = new Set();
  // moving things (other players, their cars) within r of a point, for checks beyond 'is it solid'
  function liveNear(x, z, r) {
    const out = [];
    for (const f of moving()) if (Math.hypot(f.x - x, f.z - z) < r) out.push(f);
    return out;
  }
  return { add, drop, hit, hitStatic, at, liveNear, ignore, beginFrame, live: fn => live.push(fn) };
}
