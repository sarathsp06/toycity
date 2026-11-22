// Parked cars: the cars in the parking spots of the near squares, and which of them are out.
//
// A square's file lists its parked cars as instances of STRIDE floats [x, y, z, yaw, scale, colour],
// local to the square (tilebake.py). A car is named by its key "<i>_<j>:<k>" (k: its offset in that list),
// so a car someone drove away stays gone, and a dented one stays dented, when its square unloads and
// loads again. city.js draws them and vehicle.js drives them; both ask here rather than index the floats.
//
//   const parked = createParked()
//   parked.add(tile, cars)        cars: { data, all: [{ k, model }] , ... } (city.js); sets tile.cars
//   parked.footprints(tile, fps)  the cars' solid footprints, by index; a taken car's is switched off
//   parked.drop(tile)             the square unloads
//   parked.tiles                  the squares with parked cars
//   parked.key(tile, k), parked.isTaken(key), parked.isGone(tile, k) (taken or dented)
//   parked.setTaken(key, on), parked.dented (key -> wreck mesh, or null while its square is away)
//   parked.spot(tile, k, out)     its world place: out.x, z, yaw, color
//   parked.at(key) -> { tile, k } when its square is loaded
//   parked.nearest(x, z, within)  the nearest car not taken: { tile, k, model, x, z, yaw, color } or null
//   parked.toSpot(x, z), parked.emptySpotNear(x, z, r)
//   parked.stamp                  changes whenever a car is taken or dented
//
// Nothing here touches three.js, so the unit tests (tests/parked.test.mjs) run it in node.
import { squareKey } from './grid.js';

export const STRIDE = 6;
const X = 0, Z = 2, YAW = 3, COLOR = 5;
export const carKey = (tile, k) => squareKey(tile.i, tile.j) + ':' + k;
const prefixOf = tile => squareKey(tile.i, tile.j) + ':';

export function createParked() {
  const tiles = new Set(), taken = new Set();
  const dented = new Map();   // key -> the wreck standing in for the car (vehicle.js), null while its square is away
  const pre = new Map();      // tile -> its key prefix, made once
  const prefix = tile => pre.get(tile) || prefixOf(tile);
  function add(tile, cars) { tile.cars = cars; pre.set(tile, prefixOf(tile)); tiles.add(tile); }
  function drop(tile) { tiles.delete(tile); pre.delete(tile); }
  function footprints(tile, fps) {
    tile.carFps = fps; const p = prefixOf(tile);
    for (let n = 0; n < fps.length; n++) if (taken.has(p + n * STRIDE)) fps[n].off = true;
  }
  const key = (tile, k) => prefix(tile) + k;
  const isGone = (tile, k) => { if (!taken.size && !dented.size) return false; const kk = key(tile, k); return taken.has(kk) || dented.has(kk); };
  // the square of a key, if loaded
  function at(k) {
    for (const t of tiles) { const p = prefix(t); if (k.startsWith(p)) return { tile: t, k: +k.slice(p.length) }; }
    return null;
  }
  function setTaken(k, on) {
    on ? taken.add(k) : taken.delete(k);
    for (const t of tiles) { const p = prefix(t); if (t.carFps && k.startsWith(p)) { const f = t.carFps[+k.slice(p.length) / STRIDE]; if (f) f.off = on; } }
  }
  function spot(tile, k, out = {}) {
    const d = tile.cars.data, o = tile.group.position;
    out.x = d[k + X] + o.x; out.z = d[k + Z] + o.z; out.yaw = d[k + YAW]; out.color = d[k + COLOR];
    return out;
  }
  function nearest(x, z, within) {
    let best = null, bd = within;
    for (const tile of tiles) {
      const { data, all } = tile.cars, ox = tile.group.position.x, oz = tile.group.position.z, p = prefix(tile);
      for (const { k, model } of all) {
        const d = Math.hypot(data[k + X] + ox - x, data[k + Z] + oz - z);
        if (d >= bd || taken.has(p + k)) continue;
        bd = d; best = { tile, k, model, x: data[k + X] + ox, z: data[k + Z] + oz, yaw: data[k + YAW], color: data[k + COLOR] };
      }
    }
    return best;
  }
  // distance to the nearest parking spot (taken ones count: that is where you took it from)
  function toSpot(x, z) {
    let bd = Infinity;
    for (const tile of tiles) {
      const { data } = tile.cars, ox = tile.group.position.x, oz = tile.group.position.z;
      for (let k = 0; k < data.length; k += STRIDE) bd = Math.min(bd, Math.hypot(data[k + X] + ox - x, data[k + Z] + oz - z));
    }
    return bd;
  }
  // the nearest parking spot within r metres whose car is out (yours, or another player's): { x, z, yaw }
  function emptySpotNear(x, z, r) {
    let best = null, bd = r;
    for (const tile of tiles) {
      const { data } = tile.cars, ox = tile.group.position.x, oz = tile.group.position.z, p = prefix(tile);
      for (let k = 0; k < data.length; k += STRIDE) {
        if (!taken.has(p + k)) continue;
        const sx = data[k + X] + ox, sz = data[k + Z] + oz, d = Math.hypot(sx - x, sz - z);
        if (d < bd) { bd = d; best = { x: sx, z: sz, yaw: data[k + YAW] }; }
      }
    }
    return best;
  }
  return {
    tiles, taken, dented, add, drop, footprints, key, isGone, at, setTaken, spot, nearest, toSpot, emptySpotNear,
    isTaken: k => taken.has(k),
    inSquare: (k, tile) => k.startsWith(prefix(tile)),
    modelAt: (tile, k) => tile.cars.all[k / STRIDE]?.model,
    get stamp() { return taken.size * 65536 + dented.size; },
  };
}
