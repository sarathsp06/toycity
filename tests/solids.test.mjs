// node --test tests/*.test.mjs   (solid things: cars, trees, people)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolids, footprintsOf, hits, PERSON } from '../web/solids.js';

test('a car blocks along its length, turned with its yaw', () => {
  const car = { x: 0, z: 0, hx: 2.15, hz: 0.88, yaw: 0 };
  assert.equal(hits(car, 2.0, 0, PERSON.r), true, 'at the bumper');
  assert.equal(hits(car, 0, 1.5, PERSON.r), false, 'beside it');
  const turned = { ...car, yaw: Math.PI / 2 };
  assert.equal(hits(turned, 0, 2.0, PERSON.r), true, 'turned 90 degrees, its length runs along z');
  assert.equal(hits(turned, 2.0, 0, PERSON.r), false);
});
test('trees and people are circles', () => {
  assert.equal(hits({ x: 0, z: 0, r: 0.3 }, 0.5, 0, PERSON.r), true);
  assert.equal(hits({ x: 0, z: 0, r: 0.3 }, 0.7, 0, PERSON.r), false);
});
test('footprints come from instance data, offset by the square and scaled', () => {
  const tree = footprintsOf('tree', new Float32Array([1, 0, 2, 0, 2, 0]), { x: 100, z: 200 });
  assert.deepEqual(tree, [{ x: 101, z: 202, r: 0.6 }]);
  assert.deepEqual(footprintsOf('window', new Float32Array(6), { x: 0, z: 0 }), [], 'unknown kinds are not solid');
});
test('static squares come and go; live things are asked each time', () => {
  const s = createSolids();
  s.add('sq', [{ x: 10, z: 10, r: 0.3 }]);
  assert.equal(s.hit(10.4, 10, PERSON.r), true);
  s.drop('sq');
  assert.equal(s.hit(10.4, 10, PERSON.r), false);
  let other = { x: 5, z: 5, r: PERSON.r };
  s.live(() => [other]);
  assert.equal(s.hit(5.3, 5, PERSON.r), true);
  other = { x: 50, z: 5, r: PERSON.r };
  assert.equal(s.hit(5.3, 5, PERSON.r), false);
});
test('a car just across an 8 m grid cell border still blocks', () => {
  const s = createSolids();
  s.add('sq', [{ x: 8.6, z: 4, hx: 0.5, hz: 0.1, yaw: 0 }]);   // reach 0.51: cells x 8..16 only, before the slack
  assert.equal(s.hit(7.9, 4, PERSON.r), true, 'tested from the cell next door, within the person radius');
  assert.equal(s.hit(7.5, 4, PERSON.r), false);
});
test('live things are asked once per frame once beginFrame is used', () => {
  const s = createSolids(); let asked = 0;
  s.live(() => { asked++; return [{ x: 5, z: 5, r: PERSON.r }]; });
  s.hit(0, 0, PERSON.r); s.hit(0, 0, PERSON.r);
  assert.equal(asked, 2, 'no frames yet: asked on every test');
  s.beginFrame(); s.hit(0, 0, PERSON.r); s.hit(5.3, 5, PERSON.r); s.liveNear(5, 5, 1);
  assert.equal(asked, 3, 'one frame, one ask');
  s.beginFrame(); assert.equal(s.hit(5.3, 5, PERSON.r), true); assert.equal(asked, 4);
});
