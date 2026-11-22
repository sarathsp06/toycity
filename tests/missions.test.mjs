// node --test tests/*.test.mjs   (klusjes: timer, reached, hint arrow, picking, the live loop with stubs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timeLimit, reached, hint, fmtTime, pickMission, rng, createMissions, SHOPS } from '../web/missions.js';

test('timer: 90 s plus a second per 10 m', () => {
  assert.equal(timeLimit(0), 90);
  assert.equal(timeLimit(500), 140);
  assert.equal(fmtTime(140), '2:20');
  assert.equal(fmtTime(-3), '0:00');
});

test('reached: on foot within 6 m, in a car only when stopped within 10 m', () => {
  assert.ok(reached(0, 0, 5, 0));
  assert.ok(!reached(0, 0, 7, 0));
  assert.ok(reached(0, 0, 9, 0, { inCar: true, speed: 0.1 }));
  assert.ok(!reached(0, 0, 9, 0, { inCar: true, speed: 3 }), 'still rolling');
  assert.ok(!reached(0, 0, 11, 0, { inCar: true, speed: 0 }));
});

test('hint: arrow relative to the camera, distance rounded', () => {
  assert.equal(hint(0, 0, 0, -240, 0), '↑ 240 m', 'north is up with yaw 0');
  assert.equal(hint(0, 0, 240, 0, 0), '→ 240 m');
  assert.equal(hint(0, 0, 0, 240, 0), '↓ 240 m');
  assert.equal(hint(0, 0, 240, 0, -Math.PI / 2), '↑ 240 m', 'camera west of you looking east: east is up');
  assert.equal(hint(0, 0, 240, 0, Math.PI / 2), '↓ 240 m', 'camera east of you: east is behind');
  assert.equal(hint(0, 0, 1500, 0, 0), '→ 1.5 km');
  assert.equal(hint(0, 0, 3, 4, 0), '📍 10 m', 'close: a pin');
});

test('rng is deterministic', () => {
  const a = rng(42), b = rng(42);
  assert.equal(a(), b()); assert.equal(a(), b());
  assert.notEqual(rng(1)(), rng(2)());
});

const index = JSON.parse(readFileSync(new URL('../web/regions/barendrecht/search.json', import.meta.url)));
const X = 96008, Y = 430133;   // Schaatsbaan 43, Barendrecht (the start of the Barendrecht place)

test('pickMission: the same seed gives the same klusje; each kind can be made from the index', () => {
  const a = pickMission(index, X, Y, 7), b = pickMission(index, X, Y, 7);
  assert.deepEqual(a, b);
  for (const kind of ['bezorging', 'ophalen', 'rondje']) {
    const m = pickMission(index, X, Y, 3, { kind });
    assert.ok(m, kind + ' made');
    assert.equal(m.kind, kind);
    assert.ok(m.stops.length >= 1 && m.limit >= 90 && m.reward >= 1);
    assert.ok(/[a-z]/i.test(m.line), 'has a line');
    const last = m.stops[m.stops.length - 1];
    if (kind !== 'rondje') assert.match(last.label, /\s\d+\w?$/, 'ends at a house number: ' + last.label);
  }
  const r = pickMission(index, X, Y, 3, { kind: 'rondje' });
  assert.equal(r.stops.length, 3); assert.ok(r.any);
  const o = pickMission(index, X, Y, 3, { kind: 'ophalen' });
  assert.ok(SHOPS.some(s => s.re.test(o.stops[0].label)), 'fetches from a shop: ' + o.stops[0].label);
  const d = Math.hypot(o.stops[1].X - o.stops[0].X, o.stops[1].Y - o.stops[0].Y);
  assert.ok(d >= 250 && d <= 950, 'shop to house ' + d.toFixed(0) + ' m');
});

test('pickMission respects inside() and returns null when nothing fits', () => {
  assert.equal(pickMission(index, X, Y, 1, { inside: () => false }), null);
  assert.equal(pickMission({ addr: [], pois: [] }, X, Y, 1), null);
});

// a tiny stand-in for the game: a player you can move, a car you can start, notes you can read
function game() {
  const notes = [];
  const player = { position: { x: 0, y: 0, z: 0 } };
  const driving = { driving: false, speed: 0 };
  const rewards = [];
  globalThis.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); } };
  const m = createMissions({ player, driving, note: t => notes.push(t), index, toRD: (x, z) => [X + x, Y - z], fromRD: (a, b) => [a - X, Y - b], onReward: (r, s) => rewards.push([r, s]), seed: 5 });
  return { m, notes, player, driving, rewards };
}

test('live: offer, accept, walk to each stop, earn stars', async () => {
  const { m, notes, player, rewards } = game();
  assert.equal(m.active, null);
  const o = await m.offer({ kind: 'ophalen' });
  assert.ok(o && m.offered === o && notes.length === 1, 'the offer is announced once');
  m.accept();
  assert.ok(m.active && m.offered === null);
  m.update(0.016);
  assert.ok(m.active.left < m.active.limit, 'the clock runs');
  assert.match(m.line, /⏱/);
  for (const s of [...m.active.stops]) {
    player.position.x = s.x + 2; player.position.z = s.z + 2;   // walk right up to it
    m.update(0.016);
  }
  assert.equal(m.active, null, 'finished');
  assert.equal(rewards.length, 1);
  assert.equal(m.stats.stars, rewards[0][0]);
  assert.equal(m.stats.done, 1);
  assert.equal(JSON.parse(localStorage.getItem('toycity.stars')).stars, m.stats.stars, 'stars are remembered');
  assert.match(notes[notes.length - 1], /Done!/);
});

test('live: stopping too far in a car does not count; stopped nearby does', async () => {
  const { m, player, driving } = game();
  await m.offer(); m.accept();
  const t = m.active.stops[0];
  driving.driving = true; driving.speed = 4; player.position.x = t.x + 3; player.position.z = t.z;
  m.update(0.016); assert.ok(!t.done, 'driving past');
  driving.speed = 0; player.position.x = t.x + 12;
  m.update(0.016); assert.ok(!t.done, 'parked too far');
  player.position.x = t.x + 8;
  m.update(0.016); assert.ok(t.done, 'parked within 10 m');
});

test('live: too late only says so and clears the mission', async () => {
  const { m, notes } = game();
  await m.offer(); m.accept();
  m.update(m.active.limit + 1);
  assert.equal(m.active, null);
  assert.match(notes[notes.length - 1], /Too late/);
  assert.equal(m.stats.late, 1); assert.equal(m.stats.stars, 0);
  assert.ok(await m.offer(), 'and a new one is offered');
});
