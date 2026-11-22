// The presence state codec: one place that knows the wire tuple, its ranges and what its values mean.
// Pure (no browser APIs), tested by tests/mp-state.test.mjs.
//
// Wire format (unchanged since the 13-slot release, so every deployed game still understands it):
//   [seq, x, y, h, v, name, look, mic, car, card, pose, up, caps]
// Older games send fewer slots (at least the first six); missing ones decode to their defaults.
import { cleanName } from './logic.js';

export const FIELDS = ['seq', 'x', 'y', 'h', 'v', 'name', 'look', 'mic', 'car', 'card', 'pose', 'up', 'caps'];
// what someone's body is doing (body.pose in city.js); anything else on the wire reads as normal
export const POSE = Object.freeze({ normal: 0, flung: 1, lying: 2, home: 3, out: 4, door: 5, swim: 6 });
export const CARD = Object.freeze({ none: 0, yellow: 1, red: 2 });
export const UP_MIN = -3, UP_MAX = 20;   // metres: below 0 swimming at the water level, above 0 in the air
export const FALL_DOWN = 0.93;           // where in the fall clip someone lying is held (flat on the ground)
const CAR = /^[a-z0-9_]{1,12}:[0-9a-f]{1,6}$/;   // "model:colour" while driving, "ride:N" as a passenger

export const isInside = pose => pose === POSE.home;                       // at home: not drawn at all
export const isLying = pose => pose === POSE.lying || pose === POSE.out;   // flat after a hit, or knocked out
export const isSwimming = pose => pose === POSE.swim;
export const isPassenger = car => typeof car === 'string' && car.startsWith('ride:');
export const isBike = car => typeof car === 'string' && car.startsWith('bike');
export const carModel = car => { const i = car ? car.indexOf(':') : -1; return i > 0 ? car.slice(0, i) : car || ''; };
// "suv:ff8800" -> { model: 'suv', colour: 0xff8800, ride: false, seat: null }; "ride:0" -> { model: 'ride', ride: true, seat: 0 }
export function parseCar(car) {
  if (!car || !CAR.test(car)) return null;
  const [model, c] = car.split(':'), ride = model === 'ride';
  return { model, colour: ride ? null : parseInt(c, 16), ride, seat: ride ? parseInt(c, 16) : null, bike: model.startsWith('bike') };
}

// named fields -> the wire tuple (a new array: the transport may send it after this returns)
export function encodeState(s) {
  return [s.seq, +s.x.toFixed(2), +s.y.toFixed(2), +s.h.toFixed(3), +s.v.toFixed(2), s.name, s.look, s.mic ? 1 : 0, s.car || '', s.card || 0, s.pose || 0, s.up || 0, s.caps ?? 'v'];
}

// the wire tuple -> named fields, written into `into` (reused per message: no allocation), or null
// when it is not a state at all. Out-of-range values fall back to their defaults instead of failing.
export function decodeState(d, into = {}) {
  if (!Array.isArray(d) || d.length < 6) return null;
  const [s, x, y, h, v] = d;
  if (!Number.isFinite(s) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(h) || !Number.isFinite(v)) return null;
  into.seq = s; into.x = x; into.y = y; into.h = h; into.v = v;
  into.name = cleanName(d[5]);
  into.look = typeof d[6] === 'string' ? d[6] : '';   // checked against the personas by the caller (avatar.js)
  into.mic = d[7] === 1;
  into.car = typeof d[8] === 'string' && CAR.test(d[8]) ? d[8] : '';
  into.card = d[9] === 1 || d[9] === 2 ? d[9] : 0;
  into.pose = Number.isInteger(d[10]) && d[10] >= 0 && d[10] <= 6 ? d[10] : 0;
  into.up = Number.isFinite(d[11]) ? Math.max(UP_MIN, Math.min(UP_MAX, d[11])) : 0;
  into.caps = typeof d[12] === 'string' ? d[12].replace(/[^a-z]/g, '').slice(0, 8) : undefined;   // undefined: an older game, guess from the name
  return into;
}
