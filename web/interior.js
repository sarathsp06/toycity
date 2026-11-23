// The inside of a house: every house has the same ground floor (models/interior.glb, built by
// tools/interior_model.py): a hall, a kitchen, a dining table for six to meet at and a living room.
//
// It is placed under the house you go into, DEPTH metres below the street, turned like its front
// door, so the rest of the town stays out of sight and you keep your real place on the map: others
// in the same house find you there (presence sends where you are), others outside don't see you.
// Walking inside uses the same walker as outside, with the room's walls as the map and its furniture
// (interior.json) as the things you bump into or stand on.
//
//   const room = createInterior({ scene, loader, createSolids })
//   room.load()                  fetch the model (once, when someone first goes in)
//   room.enter(door)             door: { x, z, yaw } as home.js has it; -> where to stand, just in from the door
//   room.leave()
//   room.active, room.floorY     you are inside; the floor's height in the scene
//   room.blockedAt(x, z)         a wall there (the walker's map while inside)
//   room.solids                  the furniture, a solids.js registry
//   room.contains(x, z)          is this point inside the room you are in (someone else in the same house)
//   room.camera(v)               keep a camera position inside the walls
//   room.floor                   the floor meshes, for click-to-walk
//   room.seats                   [{ x, z, yaw, h, kind }] in the scene, where people can sit
//   room.seatNear(x, z, r, taken) the nearest seat within r metres not in taken (a list of [x, z])
//   room.standSpot(seat, clear)  where to stand up to (or walk to before sitting): beside the seat,
//                                clear(x, z) says whether a body fits there
import * as THREE from 'three';

export const DEPTH = -40;          // metres below the street
// while you are in a house the camera draws only this layer: the room, the people in it and the
// lights, so none of the town is drawn (city.js indoorView)
export const INDOORS = 1;
// a body is 1.8 m tall: in a 2.7 m room the feet go no higher than 0.85 m (a jump onto the sofa or the
// tea table, not through the ceiling); indoors you step up only a threshold, a sofa needs a jump
export const HEAD = 1.85, STEP_IN = 0.2;
const R = 0.3;                      // a body's radius: how close to a wall the centre may come

export function createInterior({ scene, loader, createSolids }) {
  let model = null, data = null, loading = null, door = null;
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const solids = createSolids();
  const floor = [];
  let seats = [];
  let W = 6, D = 8, H = 2.7;

  function load() {
    loading ||= Promise.all([
      loader.loadAsync(new URL('./models/interior.glb', import.meta.url).href),
      fetch(new URL('./models/interior.json', import.meta.url)).then(r => r.json()),
    ]).then(([g, j]) => {
      model = g.scene; data = j; [W, D, H] = j.size;
      model.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = o.receiveShadow = false;   // the sun is above the street, not in here
        o.frustumCulled = false;
        // the window glows like daylight; everything else is lit by the scene's sky light
        const m = o.material; if (m.emissiveIntensity !== undefined && m.emissive?.getHex()) m.emissiveIntensity = 1.4;
        if (m.name === 'floor') floor.push(o);
        o.layers.enable(INDOORS);
      });
      group.add(model);
    }).catch(e => { loading = null; throw e; });
    return loading;
  }

  // the room's own coordinates (x across, z from the door into the house, negative) <-> the scene
  const toLocal = (x, z) => { const dx = x - door.x, dz = z - door.z, c = Math.cos(door.yaw), s = Math.sin(door.yaw); return [dx * c - dz * s, dx * s + dz * c]; };
  const toWorld = (lx, lz) => { const c = Math.cos(door.yaw), s = Math.sin(door.yaw); return [door.x + lx * c + lz * s, door.z - lx * s + lz * c]; };

  function enter(d) {
    door = { x: d.x, z: d.z, yaw: d.yaw };
    group.position.set(d.x, DEPTH, d.z); group.rotation.y = d.yaw; group.visible = true;
    solids.drop('room');
    if (data) {
      solids.add('room', data.solids.map(f => { const [x, z] = toWorld(f.x, f.z); return { x, z, hx: f.hx, hz: f.hz, yaw: d.yaw, top: f.top }; }));
      seats = data.seats.map(s => { const [x, z] = toWorld(s.x, s.z); return { ...s, x, z, yaw: s.yaw + d.yaw }; });
    }
    const [x, z] = toWorld(0, -1.0);
    return { x, z, yaw: d.yaw + Math.PI };   // a step in from the door, facing into the house
  }
  function leave() { door = null; group.visible = false; solids.drop('room'); seats = []; }

  function inRoom(x, z, margin) { const [lx, lz] = toLocal(x, z); return lx > -W / 2 + margin && lx < W / 2 - margin && lz < -margin && lz > -D + margin; }

  function seatNear(x, z, r, taken = []) {
    let best = null, bd = r;
    for (const s of seats) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd && !taken.some(([tx, tz]) => Math.hypot(tx - s.x, tz - s.z) < 0.35)) { bd = d; best = s; }
    }
    return best;
  }
  // in front of the seat, else behind it, else to either side (a dining chair has the table in front)
  function standSpot(s, clear) {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    for (const [a, b] of [[0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75], [1.1, 0], [-1.1, 0]]) {
      const x = s.x + fx * a + fz * b, z = s.z + fz * a - fx * b;
      if (clear(x, z)) return [x, z];
    }
    return [s.x + fx * 0.75, s.z + fz * 0.75];
  }

  return {
    load, enter, leave, solids, seatNear, standSpot,
    get active() { return !!door; },
    get group() { return group; },
    get door() { return door; },
    get floorY() { return DEPTH; },
    get ceiling() { return H - HEAD; },
    get floor() { return floor; },
    get seats() { return seats; },
    blockedAt: (x, z) => !door || !inRoom(x, z, R),
    contains: (x, z) => !!door && inRoom(x, z, 0),
    camera(v) {
      if (!door) return;
      const [lx, lz] = toLocal(v.x, v.z), m = 0.15;
      const cx = Math.min(W / 2 - m, Math.max(-W / 2 + m, lx)), cz = Math.min(-m, Math.max(-D + m, lz));
      const [x, z] = toWorld(cx, cz); v.x = x; v.z = z;
      v.y = Math.min(DEPTH + H - 0.2, Math.max(DEPTH + 0.3, v.y));
    },
  };
}
