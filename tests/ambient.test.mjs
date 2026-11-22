// node --test tests/*.test.mjs   (ambient traffic and people: deterministic loops on the wall clock)
import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, rng, laneLoop, timeTable, sample, catchUp, cornerSpeed, densify, buildLoop, limitOf, createFleet } from '../web/ambient.js';

test('the same id seeds the same numbers on every device', () => {
  const a = rng(seed('rotterdam', '3_4:1')), b = rng(seed('rotterdam', '3_4:1')), c = rng(seed('rotterdam', '3_4:2'));
  const xs = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], xs);
  assert.notDeepEqual([c(), c(), c()], xs);
  assert.ok(xs.every(x => x >= 0 && x < 1));
});
test('a square loop keeps to its right-hand side, all the way round', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];   // clockwise seen from above with z down: right of +x is +z
  const out = laneLoop(sq, 1);
  assert.ok(out.every(([x, z]) => x > 0 && x < 10 && z > 0 && z < 10), 'every point moved inwards (its right): ' + JSON.stringify(out));
  const mid = laneLoop([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]], 1)[1];
  assert.deepEqual(mid.map(v => +v.toFixed(6)), [5, 1], 'a point on a straight sits the full lane to the right');
  assert.equal(laneLoop([[0, 0], [0.5, 0], [10, 0], [10, 10], [0, 10], [0.2, 0.2]], 0).length, 4, 'near-duplicate points and the closing point go');
});
test('the time table runs the loop at the segment speeds and pauses at dwells', () => {
  const tab = timeTable([[0, 0], [10, 0], [10, 10]], () => 2, i => (i === 1 ? 5 : 0));
  assert.equal(+tab.L.toFixed(3), +(20 + Math.hypot(10, 10)).toFixed(3));
  assert.equal(+tab.P.toFixed(3), +(tab.L / 2 + 5).toFixed(3));
  const o = {};
  sample(tab, 2.5, o); assert.deepEqual([o.x, o.z, o.v], [5, 0, 2]);
  sample(tab, 7, o); assert.deepEqual([o.x, o.z, o.v], [10, 0, 0], 'standing at the corner');
  sample(tab, 10 + 2.5, o); assert.deepEqual([o.x, +o.z.toFixed(6), o.v], [10, 5, 2], 'on the way again after the 5 s pause');
  sample(tab, tab.P * 3 + 2.5, o); assert.deepEqual([o.x, o.z], [5, 0], 'periodic');
  sample(tab, -tab.P + 2.5, o); assert.deepEqual([o.x, o.z], [5, 0], 'and for times before zero');
});
test('the polite lag grows while waiting and is made up at 1.5x', () => {
  let lag = 0; for (let i = 0; i < 10; i++) lag = catchUp(lag, 0.1, true);
  assert.equal(+lag.toFixed(6), 1);
  for (let i = 0; i < 10; i++) lag = catchUp(lag, 0.1, false);
  assert.equal(+lag.toFixed(6), 0.5);
  assert.equal(catchUp(0.01, 1, false), 0, 'never below zero');
});
test('bends slow the car down, straights do not', () => {
  const pts = [[0, 0], [10, 0], [20, 0], [20, 10]];
  assert.equal(cornerSpeed(pts, 1, 14, 4), 14);
  assert.ok(cornerSpeed(pts, 2, 14, 4) < 5);
  const { pts: d, extra } = densify([[0, 0], [30, 0]], 10, [50, 30]);
  assert.equal(d.length, 6); assert.deepEqual(extra, [50, null, null, 30, null, null]);
});
test('a loop is built from a graph by id, there and back, the same every time', () => {
  // a 2 km straight road of nodes 100 m apart, two-way, 50 km/h: node 0 .. 20
  const N = 21, xs = new Float64Array(N), zs = new Float64Array(N), out = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) { xs[i] = i * 100; if (i) { out[i - 1].push(i, 3 | 4 | 50 << 4); out[i].push(i - 1, 3 | 4 | 50 << 4); } }
  const g = { xs, zs, out };
  assert.equal(limitOf(g, 3, 4), 50);
  const route = (a, b) => { const r = []; for (let v = a; v !== b; v += Math.sign(b - a)) r.push(v); r.push(b); return r; };
  const mk = () => buildLoop(g, { id: '0_0:0', slug: 'test', a: 10, bit: 4, route, lane: 1.5, speedAt: l => Math.min(l, 50) / 3.6 });
  const l1 = mk(), l2 = mk();
  assert.ok(l1 && l1.tab.L >= 600 && l1.tab.L <= 1700, 'out and back: 2 x 300..800 m');
  assert.deepEqual(Array.from(l1.tab.T), Array.from(l2.tab.T)); assert.equal(l1.phase, l2.phase);
  const o = {}; sample(l1.tab, 5, o); assert.ok(Math.abs(o.z) > 1 && Math.abs(o.z) < 2, 'driving on the right, 1.5 m off the line');
});
test('the fleet gives the nearest loops a slot and drops them beyond reach', () => {
  const tab = timeTable([[0, 0], [100, 0], [100, 100]], () => 5);
  const f = createFleet({ slug: 't', T: 500, toRD: (x, z) => [x + 250, 250 - z], nodesOf: k => (k === '0_0' ? [1, 2, 3] : []),
    plan: () => ({ tab, phase: 0 }), per: 1.5, show: 2, radius: 350 });
  let act = f.update(0.6, 0, 0); f.update(0.016, 0, 0); f.update(0.016, 0, 0); f.update(0.016, 0, 0); f.update(0.6, 0, 0);
  assert.equal(f.count, 2, 'two slots for three ids in the only square');
  assert.ok(act.every(a => !a || a.d < 350));
  f.update(0.6, 5000, 5000); f.update(0.6, 5000, 5000);
  assert.equal(f.count, 0, 'all out of reach');
});
