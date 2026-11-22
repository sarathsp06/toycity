// node --test tests/*.test.mjs   (the map grid: RD <-> scene, square keys, the 0.5 m bitmaps)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, squareKey, getBit, setBit, newBitmap, BYTES, SIDE, CELL } from '../web/grid.js';

const g = createGrid(92000, 433000, 500);

test('RD and scene coordinates round-trip; z points south', () => {
  assert.deepEqual(g.toRD(10, -20), [92010, 433020]);
  assert.deepEqual(g.fromRD(92010, 433020), [10, -20]);
  const [x, z] = g.fromRD(...g.toRD(-123.25, 456.5)); assert.equal(x, -123.25); assert.equal(z, 456.5);
});

test('square keys from indices, RD and scene points', () => {
  assert.equal(squareKey(184, 866), '184_866');
  assert.equal(g.keyAtRD(92000, 433000), '184_866');
  assert.equal(g.keyAtRD(91999.9, 433499.9), '183_866');
  assert.equal(g.keyAt(0, 0), '184_866');
  assert.equal(g.keyAt(-0.1, 0.1), '183_865');   // west, and south of the origin
});

test('bitmaps: 1000 x 1000 cells of 0.5 m, row by row northwards', () => {
  assert.equal(BYTES, 125000); assert.equal(SIDE * CELL, 500);
  const b = newBitmap(); assert.equal(b.length, BYTES);
  const bit = g.cellBit(92000 + 10.2, 433000 + 3.7, 184, 866);
  assert.equal(bit, 7 * 1000 + 20);
  assert.equal(getBit(b, bit), 0); setBit(b, bit); assert.equal(getBit(b, bit), 1);
  assert.equal(getBit(b, bit + 1), 0); assert.equal(getBit(b, bit - 1), 0);
  assert.equal(g.cellBit(92499.99, 433499.99, 184, 866), 999999);
  setBit(b, 999999); assert.equal(b[124999], 0x80);
});
