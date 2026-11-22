// node --test tests/*.test.mjs   (parked cars: keys, taken and dented, the nearest one)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createParked, carKey, STRIDE } from '../web/parked.js';

// a square 1_2 with two cars: [x, y, z, yaw, scale, colour] local to the square
function square() {
  const data = [10, 0, -10, 0.5, 1, 0xff0000, 30, 0, -10, 1.5, 1, 0x00ff00];
  return { tile: { i: 1, j: 2, group: { position: { x: 500, z: -1000 } } }, cars: { data, all: [{ k: 0, model: { name: 'suv' } }, { k: STRIDE, model: { name: 'bike' } }] } };
}

test('a car is named by its square and offset', () => {
  const p = createParked(), { tile, cars } = square(); p.add(tile, cars);
  assert.equal(carKey(tile, 6), '1_2:6'); assert.equal(p.key(tile, 6), '1_2:6');
  assert.deepEqual(p.at('1_2:6'), { tile, k: 6 }); assert.equal(p.at('9_9:0'), null);
  assert.equal(p.modelAt(tile, 6).name, 'bike');
  assert.deepEqual(p.spot(tile, 6), { x: 530, z: -1010, yaw: 1.5, color: 0x00ff00 });
});

test('the nearest car that is still there', () => {
  const p = createParked(), { tile, cars } = square(); p.add(tile, cars);
  const fps = [{}, {}]; p.footprints(tile, fps);
  assert.equal(p.nearest(511, -1010, 4).k, 0);
  assert.equal(p.nearest(520, -1010, 4), null, 'none within reach');
  const s0 = p.stamp; p.setTaken('1_2:0', true);
  assert.notEqual(p.stamp, s0); assert.ok(p.isTaken('1_2:0')); assert.ok(p.isGone(tile, 0)); assert.ok(fps[0].off);
  assert.equal(p.nearest(511, -1010, 4), null);
  assert.equal(p.toSpot(511, -1010), 1, 'a taken spot still counts as a spot');
  assert.deepEqual(p.emptySpotNear(511, -1010, 3), { x: 510, z: -1010, yaw: 0.5 });
  p.setTaken('1_2:0', false); assert.ok(!fps[0].off); assert.equal(p.emptySpotNear(511, -1010, 3), null);
});

test('taken and dented survive the square going away and coming back', () => {
  const p = createParked(); let { tile, cars } = square(); p.add(tile, cars);
  p.setTaken('1_2:6', true); p.dented.set('1_2:0', null);
  p.drop(tile); assert.equal(p.tiles.size, 0); assert.equal(p.at('1_2:6'), null);
  ({ tile, cars } = square()); const fps = [{}, {}]; p.footprints(tile, fps); p.add(tile, cars);
  assert.ok(fps[1].off && !fps[0].off); assert.ok(p.isGone(tile, 0)); assert.ok(p.inSquare('1_2:0', tile));
});
