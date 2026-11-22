// the presence state codec (web/mp/state.js): the 13-slot wire tuple, its ranges and the pose names
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeState, decodeState, FIELDS, POSE, FALL_DOWN, isInside, isLying, isSwimming, isPassenger, isBike, carModel, parseCar } from '../web/mp/state.js';

const full = { seq: 7, x: 92000.123, y: 437000.456, h: 1.23456, v: 1.234, name: 'Ada', look: 'zuri:3', mic: true, car: 'suv:ff8800', card: 1, pose: POSE.swim, up: -0.5, caps: 'v' };

test('encode gives the 13-slot tuple deployed games send', () => {
  const d = encodeState(full);
  assert.equal(d.length, 13); assert.equal(FIELDS.length, 13);
  assert.deepEqual(d, [7, 92000.12, 437000.46, 1.235, 1.23, 'Ada', 'zuri:3', 1, 'suv:ff8800', 1, 6, -0.5, 'v']);
});
test('decode round-trips into named fields, reusing the object', () => {
  const into = {}, s = decodeState(encodeState(full), into);
  assert.equal(s, into);
  assert.deepEqual({ ...s }, { seq: 7, x: 92000.12, y: 437000.46, h: 1.235, v: 1.23, name: 'Ada', look: 'zuri:3', mic: true, car: 'suv:ff8800', card: 1, pose: 6, up: -0.5, caps: 'v' });
  assert.equal(decodeState([8, 1, 2, 3, 4, 'Bo'], into), into);
  assert.equal(into.name, 'Bo'); assert.equal(into.car, ''); assert.equal(into.caps, undefined, 'an older game: no caps');
});
test('decode rejects what is not a state', () => {
  for (const d of [null, {}, [1, 2, 3], [1, 'x', 2, 3, 4, 'n'], [NaN, 1, 2, 3, 4, 'n'], [1, 1, 2, Infinity, 4, 'n']]) assert.equal(decodeState(d), null);
});
test('decode clamps and defaults out-of-range values', () => {
  const s = decodeState([1, 0, 0, 0, 0, 'a<b>\u0001', 5, 'yes', 'BAD CAR', 3, 7, 99, 'V!x123yzabcdefgh']);
  assert.equal(s.name, 'ab'); assert.equal(s.look, ''); assert.equal(s.mic, false); assert.equal(s.car, '');
  assert.equal(s.card, 0); assert.equal(s.pose, 0); assert.equal(s.up, 20); assert.equal(s.caps, 'xyzabcde');
  assert.equal(decodeState([1, 0, 0, 0, 0, '', '', 1, '', 2, 1.5, -9]).pose, 0, 'pose must be an integer');
  assert.equal(decodeState([1, 0, 0, 0, 0, '', '', 1, '', 2, 4, -9]).up, -3);
  for (let p = 0; p <= 6; p++) assert.equal(decodeState([1, 0, 0, 0, 0, '', '', 0, '', 0, p]).pose, p);
});
test('pose names and predicates', () => {
  assert.deepEqual({ ...POSE }, { normal: 0, flung: 1, lying: 2, home: 3, out: 4, door: 5, swim: 6 });
  assert.ok(isInside(3) && !isInside(0));
  assert.ok(isLying(2) && isLying(4) && !isLying(1));
  assert.ok(isSwimming(6) && !isSwimming(5));
  assert.equal(FALL_DOWN, 0.93);
});
test('car strings: model:colour and ride:N', () => {
  assert.ok(isPassenger('ride:0') && !isPassenger('suv:ff0000') && !isPassenger('') && !isPassenger(undefined));
  assert.ok(isBike('bike:ff0000') && !isBike('suv:1'));
  assert.equal(carModel('suv_wreck:abc'), 'suv_wreck'); assert.equal(carModel(''), ''); assert.equal(carModel(undefined), '');
  assert.deepEqual(parseCar('golf:ff8800'), { model: 'golf', colour: 0xff8800, ride: false, seat: null, bike: false });
  assert.deepEqual(parseCar('ride:2'), { model: 'ride', colour: null, ride: true, seat: 2, bike: false });
  assert.equal(parseCar('nonsense'), null); assert.equal(parseCar(''), null);
});
