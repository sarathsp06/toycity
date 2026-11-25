// Solid things you bump into: one list of footprints and one test, whatever the thing is.
// Buildings, walls, water and hedges come from each square's baked collision bitmap (city.js);
// everything else lives here: parked cars, trees, lamp posts and street furniture from the squares,
// and moving things such as other players. Each footprint is a circle { x, z, r } or a box turned
// by `yaw` { x, z, hx, hz, yaw }, in world metres on the ground. `top` is how high its top is above the
// ground you stand on, for things you can stand on (a car roof, a bench); without it, nobody can.
//
//   const solids = createSolids();
//   solids.add(owner, [footprints])    static things, e.g. the cars of one square
//   solids.drop(owner)                 when that square unloads
//   solids.live(fn)                    fn() returns footprints that move (asked once per frame)
//   solids.beginFrame()                once per animation frame: the live footprints are asked again
//   solids.hit(x, z, r)                does a circle of radius r at (x, z) touch anything solid?
//   solids.hitStatic(x, z, r)          the same for the static things only (no allocation)
//   solids.at(x, z, r)                 the static footprints that circle touches
//   solids.topAt(x, z, r)              the highest top a circle there stands on (0: none)
//   solids.hitAbove(x, z, r, y)        like hit, counting only things whose top is above y (or that have none)

// footprint of each kind of placed object, by its instance name, for a scale of 1; top: metres above
// the pavement (measured on the models), only for things a person can stand on
export const FOOTPRINTS = {
  car: { hx: 2.15, hz: 0.88, top: 1.45 },   // length along the car, width across; the roof
  tree: { r: 0.3 },                   // the trunk (you walk under the crown)
  lamp: { r: 0.15 },
  'furn:bollard': { r: 0.12, top: 0.75 },
  'furn:bench': { hx: 0.9, hz: 0.25, top: 0.3 },
  'furn:bin': { r: 0.3, top: 0.85 },
  'furn:postbox': { r: 0.3, top: 1.1 },
  'furn:busstop': { hx: 1.6, hz: 0.7, top: 2.5 },
};
export const PERSON = { r: 0.3 };
// the road's top in the scene (buildtiles.mjs TOP.road): every `top` above is measured from it, and a
// car's wheels, a person's feet on the road and the walker's height 0 all stand here
export const ROAD = 0.15;
// what you stand on and bump into: a piece with `parts` (a sofa or a chair: its back, arms and cushion,
// each with its own top, measured by tools/interior_model.py) is those parts, anything else its whole
// footprint. A top is the surface the feet meet, never just the highest point of the piece.
export const standOn = list => list.flatMap(f => f.parts || [f]);

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
    const f = fp.r !== undefined ? { x, z, r: fp.r * sc } : { x, z, hx: fp.hx * sc, hz: fp.hz * sc, yaw: data[k + 3] };
    if (fp.top !== undefined) f.top = fp.top * sc;
    out.push(f);
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
  // the highest top under a circle (feet): only things with a top count; 0 when there is none
  function topAt(x, z, r) {
    let top = 0;
    for (const f of grid.get(cellOf(x, z)) || []) if (f.top > top && hits(f, x, z, r)) top = f.top;
    for (const f of moving()) if (f.top > top && !(f.id && ignore.has(f.id)) && hits(f, x, z, r)) top = f.top;
    return top;
  }
  function hitAbove(x, z, r, y) {
    for (const f of grid.get(cellOf(x, z)) || []) if (!(f.top <= y) && hits(f, x, z, r)) return true;
    for (const f of moving()) if (!(f.top <= y) && !(f.id && ignore.has(f.id)) && hits(f, x, z, r)) return true;
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
  return { add, drop, hit, hitStatic, at, topAt, hitAbove, liveNear, ignore, beginFrame, live: fn => live.push(fn) };
}
