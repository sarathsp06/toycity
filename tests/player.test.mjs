// node --test tests/*.test.mjs   (what the player is doing: one answer to "may I jump now?")
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerMode, POSE, FALL_DOWN } from '../web/player.js';

// the same sources city.js hands over, all at rest: on foot, on the ground
function world() {
  const s = { driving: { driving: false, rider: false }, ride: null, fly: false, swim: { on: false }, fling: { on: false, down: 0 },
    jump: { phase: null, h: 0 }, homes: { busy: false, inside: false }, health: { out: 0 } };
  let stopped = 0;
  const you = createPlayerMode(s, { stopWalk: () => { stopped++; } });
  return { s, you, get stopped() { return stopped; } };
}

test('on foot by default: every action is open', () => {
  const { you } = world();
  assert.equal(you.mode, 'foot'); assert.equal(you.pose, POSE.normal);
  for (const a of ['jump', 'swim', 'car', 'walk', 'hit', 'door']) assert.equal(you.can(a), true, a);
  assert.ok(you.onFoot); assert.ok(!you.seated); assert.ok(!you.atHome);
  assert.throws(() => you.can('teleport'));
});

test('the jump guard is the same everywhere: no jumping seated, flying, swimming, at a door or in the air (indoors you may)', () => {
  const cases = [
    ['driving', s => { s.driving.driving = true; }],
    ['riding along', s => { s.ride = { name: 'Ann' }; }],
    ['flying', s => { s.fly = true; }],
    ['swimming', s => { s.swim.on = true; }],
    ['going through a door', s => { s.homes.busy = true; }],
    ['flung', s => { s.fling.on = true; }],
    ['already jumping', s => { s.jump.phase = 'air'; }],
  ];
  for (const [name, set] of cases) { const { s, you } = world(); set(s); assert.equal(you.can('jump'), false, name); }
  const { s, you } = world(); s.homes.inside = true; assert.equal(you.can('jump'), true);   // on the sofa
});

test('modes follow the frame loop order', () => {
  const { s, you } = world();
  s.swim.on = true; assert.equal(you.mode, 'swim');
  s.homes.inside = true; assert.equal(you.mode, 'indoors');
  s.homes.busy = true; assert.equal(you.mode, 'door');
  s.fling.on = true; assert.equal(you.mode, 'flung');
  s.health.out = 12; assert.equal(you.mode, 'down');
  s.driving.driving = true; assert.equal(you.mode, 'car');
  s.driving.rider = true; assert.equal(you.mode, 'bike');
  s.ride = {}; assert.equal(you.mode, 'passenger');
  s.fly = true; assert.equal(you.mode, 'fly');
});

test('the pose numbers others see stay as they were', () => {
  const { s, you } = world();
  assert.deepEqual({ ...POSE }, { normal: 0, flung: 1, lying: 2, home: 3, out: 4, door: 5, swim: 6 });
  s.swim.on = true; assert.equal(you.pose, 6);
  s.fling.on = true; assert.equal(you.pose, 1);
  s.fling.down = 0.5; assert.equal(you.pose, 2);
  s.health.out = 3; assert.equal(you.pose, 4);
  s.homes.busy = true; assert.equal(you.pose, 5);
  s.homes.inside = true; assert.equal(you.pose, 3);
  assert.equal(FALL_DOWN, 0.93);
});

test('other guards: swim, car, walk, being hit, doors', () => {
  let w = world(); w.s.fling.on = true;
  assert.equal(w.you.can('swim'), false); assert.equal(w.you.can('door'), false); assert.equal(w.you.can('car'), true);
  w = world(); w.s.health.out = 5; assert.equal(w.you.can('car'), false);
  w = world(); w.s.swim.on = true; assert.equal(w.you.can('car'), false); assert.equal(w.you.can('walk'), true);
  w = world(); w.s.homes.inside = true; assert.equal(w.you.can('walk'), true); assert.equal(w.you.can('car'), false); assert.equal(w.you.can('hit'), true);   // walking about the house
  w = world(); w.s.homes.busy = true; assert.equal(w.you.can('walk'), false); assert.equal(w.you.can('jump'), false);   // in the doorway
  w = world(); w.s.driving.driving = true; assert.equal(w.you.can('hit'), false); assert.ok(w.you.seated);
});

test('halt stops the walk and drops out of a jump', () => {
  const w = world(); w.s.jump.phase = 'air'; w.s.jump.h = 0.8;
  w.you.halt();
  assert.equal(w.s.jump.phase, null); assert.equal(w.s.jump.h, 0); assert.equal(w.stopped, 1);
});
