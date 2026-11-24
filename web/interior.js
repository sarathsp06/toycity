// The inside of a house: every house has the same ground floor (models/interior.glb, built by
// tools/interior_model.py): a hall, a kitchen and a lounge to sit and talk in (sofas round a tea table,
// the TV, two armchairs).
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
//   room.camera(v, target)       the camera on a boom from target to v, shortened at walls and tall furniture
//   room.clamp(v, m)             move a point (x, z) to at least m metres inside the walls
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
// a body's radius: the walker tests walls at points this far round the body (walker.js PROBES), so the
// map itself is the bare room; furniture is bumped into at BODY (shoulders, a little slimmer than outside)
const R = 0.3;
export const BODY = 0.22;
// a soft dark patch where something meets the floor: indoors there are no shadow maps, so furniture and
// people get these instead. Layer INDOORS only: only the indoor camera draws them
let blobMat = null;
function blobMaterial() {
  if (blobMat) return blobMat;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(0,0,0,.6)'); r.addColorStop(0.55, 'rgba(0,0,0,.4)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return (blobMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }));
}
export function blobMesh(size) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), blobMaterial());
  m.position.y = 0.02; m.layers.set(INDOORS); m.renderOrder = 1; m.raycast = () => {}; return m;
}
// one blob per piece of furniture (interior.json solids, in the room's own coordinates), one draw call
function contactShadows(list) {
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blobMaterial(), list.length), m = new THREE.Matrix4();
  list.forEach((f, i) => mesh.setMatrixAt(i, m.makeScale(f.hx * 2.5 + 0.2, 1, f.hz * 2.5 + 0.2).setPosition(f.x, 0.02, f.z)));
  mesh.layers.set(INDOORS); mesh.renderOrder = 1; mesh.frustumCulled = false; mesh.raycast = () => {};
  return mesh;
}

export function createInterior({ scene, loader, createSolids }) {
  let model = null, data = null, loading = null, door = null;
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const solids = createSolids();
  const floor = [];
  let seats = [], lights = [];
  const sky = [], lampParts = [], lampAt = new THREE.Vector3(1e9, 0, 0);
  const skyDir = new THREE.Vector3(0, 20, 0);   // where the daylight comes from: the back window
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
        // the windows glow like the sky outside (daylight() dims them at night); the ceiling lamp is
        // hidden when the camera comes up against it
        const m = o.material; if (m.emissiveIntensity !== undefined && m.emissive?.getHex()) sky.push(m);
        for (let q = o; q && q !== g.scene; q = q.parent) if (/lamp/i.test(q.name)) { lampParts.push(o); break; }
        if (m.name === 'floor') floor.push(o);
        o.layers.enable(INDOORS);
      });
      group.add(model, contactShadows(j.solids)); daylight(1);
    }).catch(e => { loading = null; throw e; });
    return loading;
  }

  function daylight(k) { for (const m of sky) m.emissiveIntensity = 0.15 + 1.25 * k; }

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
      lights = (data.lights || []).map(([lx, ly, lz]) => { const [x, z] = toWorld(lx, lz); return [x, DEPTH + ly, z]; });
      if (lights[0]) lampAt.set(...lights[0]);
    }
    // daylight from the back window, a little from the side (city.js turns the sun to come through it)
    const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
    skyDir.set(0.35 * c - s, 0.8, -0.35 * s - c).setLength(20);
    const [x, z] = toWorld(0, -1.5);   // far enough in for the camera to fit behind you
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
    load, enter, leave, solids, seatNear, standSpot, daylight,
    get lights() { return lights; },
    get skyDir() { return skyDir; },
    get active() { return !!door; },
    get group() { return group; },
    get door() { return door; },
    get floorY() { return DEPTH; },
    get ceiling() { return H - HEAD; },
    get floor() { return floor; },
    get seats() { return seats; },
    blockedAt: (x, z) => !door || !inRoom(x, z, 0.02),
    contains: (x, z) => !!door && inRoom(x, z, 0),
    clamp(v, m = 0.35) {
      if (!door) return v;
      const [lx, lz] = toLocal(v.x, v.z);
      const [x, z] = toWorld(Math.min(W / 2 - m, Math.max(-W / 2 + m, lx)), Math.min(-m, Math.max(-D + m, lz)));
      v.x = x; v.z = z; return v;
    },
    // the camera on a boom from your head (target) to where it wants to be (v): shortened where it would
    // leave the room or go into tall furniture, so it slides in along the same line instead of jumping
    // over your head; the ceiling lamp disappears when the camera is at it
    camera(v, target) {
      if (!door) return;
      const [ax, az] = toLocal(target.x, target.z), [bx, bz] = toLocal(v.x, v.z), m = 0.25;
      let t = 1;
      const cut = (a, b, lo, hi) => { if (b < lo) t = Math.min(t, (lo - a) / (b - a)); else if (b > hi) t = Math.min(t, (hi - a) / (b - a)); };
      cut(ax, bx, -W / 2 + m, W / 2 - m); cut(az, bz, -D + m, -m);
      t = Math.max(0, t);
      for (let k = 1; k <= 4; k++) {   // shelves, an armchair's back: stop just before it
        const q = t * k / 4, px = target.x + (v.x - target.x) * q, pz = target.z + (v.z - target.z) * q, py = target.y + (v.y - target.y) * q;
        if (solids.hitAbove(px, pz, 0.12, py - DEPTH)) { t *= (k - 1) / 4; break; }
      }
      v.lerpVectors(target, v, t);
      v.y = Math.min(DEPTH + H - 0.25, Math.max(DEPTH + 0.3, v.y));
      const hide = v.distanceToSquared(lampAt) < 0.64;
      for (const o of lampParts) o.visible = !hide;
    },
  };
}
