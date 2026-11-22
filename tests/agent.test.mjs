// node --test tests/*.test.mjs   (the AI agent's in-page adapter, web/agent.js, against a fake game)
import test from 'node:test';
import assert from 'node:assert/strict';
import { POSE, bearing, doing, canTalk, trailStep, install } from '../web/agent.js';

test('compass bearings: 0 north (-z), 90 east', () => {
  assert.equal(bearing(0, -1), 0); assert.equal(bearing(1, 0), 90); assert.equal(bearing(0, 1), 180); assert.equal(bearing(-1, 0), 270);
});

test('what a peer is doing, from their pose and car', () => {
  assert.equal(doing({ pose: POSE.lying }), 'lying on the ground');
  assert.equal(doing({ pose: POSE.swim }), 'swimming');
  assert.equal(doing({ pose: POSE.out }), 'knocked out');
  assert.equal(doing({ car: 'bike:ff0000' }), 'on a motorbike');
  assert.equal(doing({ car: 'sedan:00ff00' }), 'driving');
  assert.equal(doing({ player: { inside: true } }), 'riding in a car');
  assert.equal(doing({ pose: 0, speed: 3 }), 'running');
  assert.equal(doing({ pose: 0, speed: 1 }), 'walking');
  assert.equal(doing({ pose: 0, speed: 0 }), 'standing');
});

test('can_talk: the game\'s own rule first, else caps, else not an agent', () => {
  assert.equal(canTalk({ id: 'a', caps: '' }, { canTalk: id => id === 'a' }), true);
  assert.equal(canTalk({ caps: 'v' }), true); assert.equal(canTalk({ caps: '' }), false);
  assert.equal(canTalk({ name: '🤖 Bot' }), false); assert.equal(canTalk({ name: 'Ann' }), true);
});

test('following: walk their trail, stop gap metres short, run when far behind', () => {
  const f = { gap: 2.5, trail: [] };
  let s = trailStep(f, { x: 0, z: 0 }, { x: 0, z: -2 });
  assert.ok(s.stay, 'close enough: stay');
  s = trailStep({ gap: 2.5, trail: [] }, { x: 0, z: 0 }, { x: 0, z: -5 });
  assert.ok(s.to && !s.run); assert.ok(Math.abs(s.to[1] + 2.5) < 1e-9, 'straight at them, gap short');
  // they turned a corner: the trail goes via the corner, not through the house
  const g = { gap: 2.5, trail: [] };
  trailStep(g, { x: 0, z: 0 }, { x: 0, z: -6 }); trailStep(g, { x: 0, z: 0 }, { x: 0, z: -10 });
  s = trailStep(g, { x: 0, z: 0 }, { x: 5, z: -10 });
  assert.deepEqual(s.to, [0, -6]); assert.ok(s.run, 'more than 7 m behind: run');
});

test('install: snapshot lists the people in sight, nearest first, without decoding anything twice', () => {
  const peer = (id, name, x, z, extra = {}) => ({ id, name, dist: Math.hypot(x, z), speed: 0, pose: 0, player: { group: { visible: true, position: { x, z } } }, ...extra });
  const peers = new Map([['a', peer('a', 'Ann', 0, -20)], ['b', peer('b', '🤖 Bob', 5, 0, { caps: 'v', pose: POSE.swim })], ['c', peer('c', 'Far', 100, 0)]]);
  const el = () => ({ hidden: true, classList: { contains: () => true }, textContent: '' });
  const w = {
    document: { getElementById: el, querySelectorAll: () => [] },
    __agent: { walking: false, riding: null, stop() {}, walkTo: () => true },
    __city: { player: { position: { x: 0, z: 0 }, rotation: { y: 0 } }, social: { presence: { peers } },
      driving: { driving: false, nearest: () => null }, homes: { inside: false, home: null, doorsNear: () => [] },
      autopilot: { active: false }, fling: { on: false }, card: { level: 0 }, nearestPlace: () => 'Dam 1 · Amsterdam' },
  };
  const api = install(w);
  assert.equal(w.__agentApi, api);
  const s = api.snapshot();
  assert.deepEqual(s.people.map(p => [p.name, p.metres, p.bearing, p.doing, p.can_talk]), [['🤖 Bob', 5, 90, 'swimming', true], ['Ann', 20, 0, 'standing', true]]);
  assert.equal(s.nearest_address, 'Dam 1, Amsterdam'); assert.equal(s.doing, 'standing'); assert.equal(s.following, null);
  assert.equal(api.names(), 'Ann, Bob');
  const f = api.follow('ann', 2.5); assert.deepEqual(f, { name: 'Ann', metres: 20 });
  assert.equal(api.snapshot().following, 'Ann');
  api.stop(); assert.equal(api.snapshot().following, null);
});
