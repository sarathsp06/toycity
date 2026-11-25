// node --test tests/*.test.mjs   (walking: collision probes, a way round a wall, the jump onto a hedge)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalker, HEDGE_TOP } from '../web/walker.js';
import { createGrid, getBit, setBit, newBitmap } from '../web/grid.js';

// a fake square 0_0 with its origin at RD 0, 0: scene x = X, z = -Y. coll: walls; low: hedges; wet: water
function fakeMap() {
  const g = createGrid(0, 0, 500), coll = newBitmap(), low = newBitmap(), wet = newBitmap();
  const fill = (bits, x0, z0, x1, z1) => { for (let x = x0; x < x1; x += 0.5) for (let z = z0; z < z1; z += 0.5) { const [X, Y] = g.toRD(x, z); setBit(bits, g.cellBit(X, Y, 0, 0)); } };
  const blockedAt = (x, z, h = 0) => {
    const [X, Y] = g.toRD(x, z); if (X < 0 || Y < 0 || X >= 500 || Y >= 500) return true;
    const bit = g.cellBit(X, Y, 0, 0);
    return getBit(coll, bit) === 1 || (h < 0.5 && getBit(low, bit) === 1);
  };
  const wetAt = (x, z) => { const [X, Y] = g.toRD(x, z); return X >= 0 && Y >= 0 && X < 500 && Y < 500 && getBit(wet, g.cellBit(X, Y, 0, 0)) ? 0 : null; };
  return { coll, low, wet, fill, blockedAt, wetAt };
}

test('the body is a cross of probes: a wall 0.3 m to the side blocks, hedges only low feet', () => {
  const m = fakeMap(); m.fill(m.coll, 100, -101, 100.5, -99); m.fill(m.low, 110, -101, 111, -99);
  const w = createWalker({ blockedAt: m.blockedAt });
  assert.ok(w.blocked(100.25, -100)); assert.ok(w.blocked(99.8, -100)); assert.ok(!w.blocked(99.5, -100));
  assert.ok(w.blocked(110.5, -100));
  w.jump.h = 0.6; assert.ok(!w.blocked(110.5, -100), 'over the hedge in a jump');
  w.jump.h = 0; assert.ok(!w.lineClear(95, -100, 105, -100)); assert.ok(w.lineClear(95, -105, 105, -105));
});

test('swimming: water is open, a wall is still a wall', () => {
  const m = fakeMap(); let swimming = false;
  m.fill(m.coll, 200, -110, 220, -90); m.fill(m.wet, 200, -110, 220, -90);   // the canal is in coll too, as baked
  m.fill(m.coll, 230, -110, 231, -90);
  const w = createWalker({ blockedAt: m.blockedAt, wetAt: m.wetAt, swimming: () => swimming });
  assert.ok(w.blocked(210, -100)); swimming = true; assert.ok(!w.blocked(210, -100)); assert.ok(w.blocked(230.2, -100));
});

test('localPath goes round a wall, and every leg of it is clear', () => {
  const m = fakeMap(); m.fill(m.coll, 150, -160, 151, -140);   // a 20 m wall across the straight line
  const w = createWalker({ blockedAt: m.blockedAt });
  assert.ok(!w.lineClear(140, -150, 160, -150));
  const path = w.localPath(140, -150, 160, -150);
  assert.ok(path && path.length >= 2, JSON.stringify(path));
  assert.deepEqual(path[path.length - 1], [160, -150]);
  let [x, z] = [140, -150];
  for (const [px, pz] of path) { assert.ok(w.lineClear(x, z, px, pz), `leg to ${px}, ${pz}`); [x, z] = [px, pz]; }
});

test('localPath: no way into a walled-in yard', () => {
  const m = fakeMap();
  m.fill(m.coll, 155, -155, 165, -154); m.fill(m.coll, 155, -146, 165, -145);
  m.fill(m.coll, 155, -155, 156, -145); m.fill(m.coll, 164, -155, 165, -145);
  const w = createWalker({ blockedAt: m.blockedAt });
  assert.equal(w.localPath(140, -150, 160, -150), null);
});

test('a jump lands on top of a hedge, and walking off the top falls back down', () => {
  const m = fakeMap(); m.fill(m.low, 300, -105, 310, -95);
  const w = createWalker({ blockedAt: m.blockedAt }), j = w.jump;
  w.startJump(); assert.equal(j.phase, 'crouch');
  let top = 0;
  for (let t = 0; t < 0.3; t += 0.01) { w.stepJump(0.01, 298, -100); top = Math.max(top, j.h); }   // push off beside it
  for (let t = 0; t < 2; t += 0.01) { w.stepJump(0.01, 305, -100); top = Math.max(top, j.h); }
  assert.ok(top > 1.1 && top < 1.6, 'clears a 1.1 m hedge: ' + top);
  assert.equal(j.h, HEDGE_TOP); assert.equal(j.h, 1.1); assert.ok(j.onHedge); assert.equal(j.phase, null);
  for (let t = 0; t < 1; t += 0.01) w.stepJump(0.01, 320, -100);   // stepped off
  assert.equal(j.h, 0); assert.ok(!j.onHedge);
});

test('a hedge is as high as its mesh: feet on a low front-garden hedge stand on it, not over it', () => {
  const m = fakeMap(); m.fill(m.low, 300, -105, 310, -95);
  const w = createWalker({ blockedAt: m.blockedAt, hedge: (x, z) => x < 305 ? 0.8 : 0 }), j = w.jump;   // measured on the left half only
  assert.equal(w.floorAt(302, -100), 0.8);
  assert.equal(w.floorAt(308, -100), HEDGE_TOP);   // nothing measured there: the baked height
  w.startJump(); for (let t = 0; t < 2; t += 0.01) w.stepJump(0.01, 302, -100);
  assert.equal(j.h, 0.8);
});

test('one rule for everything you stand on: a car roof, a bench, a car rolling in under you', async () => {
  const { createSolids, FOOTPRINTS } = await import('../web/solids.js');
  const m = fakeMap(), solids = createSolids();
  const car = { x: 400, z: -100, hx: 2.15, hz: 0.88, yaw: 0, top: FOOTPRINTS.car.top };
  solids.add('sq', [car, { x: 410, z: -100, hx: 0.9, hz: 0.25, yaw: 0, top: FOOTPRINTS['furn:bench'].top }, { x: 420, z: -100, r: 0.3 }]);
  const w = createWalker({ blockedAt: m.blockedAt, solids }), j = w.jump;
  assert.ok(w.blocked(400, -100), 'a car blocks feet on the ground'); assert.ok(w.blocked(420, -100), 'a tree always blocks');
  assert.ok(!w.blocked(410, -100), 'a bench is low enough to step onto');
  // jump straight up next to the car, then over it: the roof is reachable, landing puts the feet on it
  w.startJump(); let top = 0;
  for (let t = 0; t < 0.3; t += 0.01) { w.stepJump(0.01, 397, -100); top = Math.max(top, j.h); }
  for (let t = 0; t < 2; t += 0.01) { w.stepJump(0.01, 400, -100); top = Math.max(top, j.h); }
  assert.ok(top > car.top, 'a jump clears the roof: ' + top);
  assert.equal(j.h, car.top); assert.equal(j.phase, null);
  assert.ok(!w.blocked(401, -100), 'walking about on the roof');
  for (let t = 0; t < 1; t += 0.01) w.stepJump(0.01, 405, -100);   // off the roof, onto the ground
  assert.equal(j.h, 0);
  for (let t = 0; t < 0.2; t += 0.01) w.stepJump(0.01, 410, -100);   // walk up onto the bench
  assert.equal(j.h, FOOTPRINTS['furn:bench'].top);
  car.x = 430; solids.drop('sq'); solids.add('sq2', [car]);   // a car arrives under someone standing at 430
  for (let t = 0; t < 0.5; t += 0.01) w.stepJump(0.01, 430, -100);
  assert.equal(j.h, car.top, 'lifted onto it, not standing inside it');
  let seated = false; const w2 = createWalker({ blockedAt: m.blockedAt, solids, standing: () => !seated });
  w2.jump.h = 1; seated = true; w2.stepJump(0.01, 430, -100); assert.equal(w2.jump.h, 0, 'in a car the feet are not on anything');
});

test('the feet stand on the ground\'s own height: up the kerb onto the pavement, down onto the road', () => {
  const m = fakeMap();
  const ground = (x, z) => x >= 5 ? 0.12 : 0;   // the pavement east of x = 5, the road west of it
  const w = createWalker({ blockedAt: m.blockedAt, ground });
  w.stepJump(1 / 60, 3, -10); assert.equal(w.jump.h, 0);
  assert.equal(w.blocked(5.2, -10), false);     // a 12 cm kerb is a step, not a wall
  w.stepJump(1 / 60, 6, -10); assert.equal(w.jump.h, 0.12);
  w.startJump(); let t = 0; for (; t < 2 && (w.jump.phase || t === 0); t += 1 / 60) w.stepJump(1 / 60, 6, -10);
  assert.equal(w.jump.h, 0.12);                 // a jump lands back on the pavement, not below it
  w.stepJump(1 / 60, 3, -10); for (let k = 0; k < 30; k++) w.stepJump(1 / 60, 3, -10);
  assert.equal(w.jump.h, 0);                    // stepped off the kerb: down on the road
});

test('indoors: the head meets the ceiling, and a sofa needs a jump (a low step), then you stand on its seat', () => {
  const m = fakeMap();
  const sofa = { topAt: (x, z) => (Math.abs(x - 10) < 1 && Math.abs(z + 10) < 0.4 ? 0.42 : 0), hitAbove: (x, z, r, y) => Math.abs(x - 10) < 1 + r && Math.abs(z + 10) < 0.4 + r && 0.42 > y };
  const w = createWalker({ blockedAt: m.blockedAt, solids: sofa, step: () => 0.2, ceiling: () => 0.85 });
  assert.equal(w.blocked(10, -9.3), true);       // walking into the sofa: it is in the way
  let peak = 0; w.startJump();
  for (let t = 0; t < 2; t += 1 / 60) { w.stepJump(1 / 60, 10, -12); peak = Math.max(peak, w.jump.h); }
  assert.equal(peak, 0.85);                      // not through the ceiling
  w.startJump(); for (let t = 0; t < 0.3; t += 1 / 60) w.stepJump(1 / 60, 10, -12);
  for (let t = 0; t < 1.5; t += 1 / 60) w.stepJump(1 / 60, 10, -10);   // over the sofa while in the air
  assert.equal(w.jump.h, 0.42);                  // landed on the seat
});
