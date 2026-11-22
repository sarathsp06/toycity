// node --test tests/*.test.mjs   (finding someone: turns, the walking network, the pavement offset)
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTurn, arrow, walkGraph, walkRoute, walkLine } from '../web/nav.js';

const cum = P => { const S = [0]; for (let k = 1; k < P.length; k++) S.push(S[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1])); return S; };
const fromRD = (X, Y) => [X, -Y];   // world x east, z south

test('nextTurn finds left and right turns, ignoring small kinks', () => {
  let P = [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0], [50, 0], [50, 10], [50, 20], [50, 30]];   // east, then south
  const t = nextTurn(P, cum(P), 0, 0); assert.equal(t.dir, 'right'); assert.equal(Math.round(t.in), 50);
  P = P.map(([x, z]) => [x, -z]);   // east, then north
  assert.equal(nextTurn(P, cum(P), 0, 0).dir, 'left');
  P = [[0, 0], [20, 0], [21, 0.4], [40, 0.4], [80, 0.4]];
  assert.equal(nextTurn(P, cum(P), 0, 0), null);
});

test('arrow is relative to the camera', () => {
  assert.equal(arrow(0, 0, 0, -10, 0), '↑');      // north, camera facing north
  assert.equal(arrow(0, 0, 10, 0, 0), '→');
  assert.equal(arrow(0, 0, 0, -10, Math.PI / 2), '→');   // looking west, north is to the right
});

// a street along y = 0 (RD), x 0..200, pavement on its right (south) 4 m out; a footpath short cut
// from (0, 0) north-east to (200, 0) via (100, 30) which is longer, so the street wins on distance but
// the footpath wins by cost class when it is not much longer
const E = (a, b, w) => [a, b, w];
const street = (side, off = 4, cls = 1) => side | Math.round(off * 4) << 2 | cls << 8;
function graph(edges, nodes) { return walkGraph({ n: nodes.flatMap(([x, y]) => [x * 2, y * 2]), e: edges.flat() }, fromRD); }

test('a street is walked on its pavement side, both ways', () => {
  const g = graph([E(0, 1, street(1)), E(1, 2, street(1))], [[0, 0], [100, 0], [200, 0]]);
  const there = walkLine(g, walkRoute(g, 0, 2));
  // driving east (way direction) the right is south: world z = +4
  assert.ok(there.every(([, z]) => Math.abs(z - 4) < 1e-6), JSON.stringify(there));
  const back = walkLine(g, walkRoute(g, 2, 0));   // walked the other way, the pavement is still south
  assert.ok(back.every(([, z]) => Math.abs(z - 4) < 1e-6), JSON.stringify(back));
  // pavement on both sides: keep right of the walker
  const g2 = graph([E(0, 1, street(3)), E(1, 2, street(3))], [[0, 0], [100, 0], [200, 0]]);
  assert.ok(walkLine(g2, walkRoute(g2, 2, 0)).every(([, z]) => Math.abs(z + 4) < 1e-6));
});

test('footpaths are preferred over a street without a pavement', () => {
  // 0-1-2 street without pavement (class 3), 0-3-2 footpath a little longer
  const g = graph([E(0, 1, street(0, 4, 3)), E(1, 2, street(0, 4, 3)), E(0, 3, 0), E(3, 2, 0)], [[0, 0], [50, 0], [100, 0], [50, 25]]);
  assert.deepEqual(walkRoute(g, 0, 2).map(([v]) => v), [0, 3, 2]);
  // with a pavement (class 1) the straight street wins
  const g2 = graph([E(0, 1, street(3)), E(1, 2, street(3)), E(0, 3, 0), E(3, 2, 0)], [[0, 0], [50, 0], [100, 0], [50, 25]]);
  assert.deepEqual(walkRoute(g2, 0, 2).map(([v]) => v), [0, 1, 2]);
});

test('a bend on one pavement is a single mitred corner, a change of side crosses straight over', () => {
  // east 100 m, then north 100 m, pavement on the right all the way: one corner point, inside the bend
  const g = graph([E(0, 1, street(1)), E(1, 2, street(1))], [[0, 0], [100, 0], [100, 100]]);
  const P = walkLine(g, walkRoute(g, 0, 2));
  assert.equal(P.length, 3);
  assert.ok(Math.abs(P[1][0] - 104) < 1e-6 && Math.abs(P[1][1] - 4) < 1e-6, JSON.stringify(P[1]));
  // then a footpath on: the line goes from the pavement onto the path
  const g2 = graph([E(0, 1, street(1)), E(1, 2, 0)], [[0, 0], [100, 0], [200, 0]]);
  const Q = walkLine(g2, walkRoute(g2, 0, 2));
  assert.deepEqual(Q.map(([x, z]) => [x, +z.toFixed(3)]), [[0, 4], [100, 4], [100, 0], [200, 0]]);
});
