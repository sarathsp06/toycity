// node --test tests/*.test.mjs   (birds on the water: the survey numbers, the pond chance, finding ponds)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIES, chance, pickBirds, waterBodies, swimSpots, SIZE_HALF, MIN_AREA } from '../web/birds.js';

test('every species carries its Sovon numbers and links', () => {
  for (const s of SPECIES) {
    assert.ok(s.breed >= 0 && s.breed <= 100 && s.winter >= 0 && s.winter <= 100, s.id);
    assert.match(s.atlas, /^https:\/\/portal\.sovon\.nl\/atlas\/soorten\/soort\/\d+$/);
  }
  const by = Object.fromEntries(SPECIES.map(s => [s.id, s]));
  assert.equal(by.mallard.breed, 97); assert.equal(by.swan.breed, 72); assert.equal(by.greylag.breed, 81);
});

test('pond chance: half the atlas share at SIZE_HALF, none below MIN_AREA, never above the atlas share', () => {
  const swan = SPECIES.find(s => s.id === 'swan');
  assert.equal(chance(swan, MIN_AREA - 1), 0);
  assert.ok(Math.abs(chance(swan, SIZE_HALF) - 0.36) < 1e-9);
  assert.ok(chance(swan, 1e7) < 0.72 && chance(swan, 1e7) > 0.719);
});

test('picking birds is deterministic and matches the chance over many ponds', () => {
  assert.deepEqual(pickBirds(5000, 42).map(b => [b.s.id, b.n]), pickBirds(5000, 42).map(b => [b.s.id, b.n]));
  const N = 4000, seen = {};
  for (let k = 0; k < N; k++) for (const { s } of pickBirds(3000, 1000 + k)) seen[s.id] = (seen[s.id] || 0) + 1;
  for (const s of SPECIES) assert.ok(Math.abs((seen[s.id] || 0) / N - chance(s, 3000)) < 0.03, s.id);
});

test('waterBodies splits separate ponds and measures them', () => {
  // two squares 100 m apart: 20 x 20 and 10 x 10, each two triangles
  const pos = [0, 0, 20, 0, 20, 20, 0, 20, 100, 0, 110, 0, 110, 10, 100, 10];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  const w = waterBodies(pos, idx);
  assert.equal(w.length, 2); assert.equal(w[0].area, 400); assert.equal(w[1].area, 100);
  assert.equal(w[0].cx, 10); assert.equal(w[1].cz, 5);
  const sp = swimSpots(pos, w[0], 7);
  assert.ok(sp.pts.length > 3); for (const [x, z] of sp.pts) assert.ok(x > 0 && x < 20 && z > 0 && z < 20);
});

test('visiting swans: a pond without its own is visited about as often as chance() says, the same for everyone', async () => {
  const { visiting, VISIT } = await import('../web/birds.js');
  const swan = SPECIES.find(s => s.id === 'swan');
  let n = 0; const N = 4000;
  for (let k = 0; k < N; k++) if (visiting(12345, 3000, k * VISIT + 5)) n++;
  assert.ok(Math.abs(n / N - chance(swan, 3000)) < 0.03);
  assert.equal(visiting(7, 3000, 1000), visiting(7, 3000, 1000));
  assert.equal(visiting(7, 3000, 1000), visiting(7, 3000, 1000 + 1));   // one stay: no flicker within it
});
