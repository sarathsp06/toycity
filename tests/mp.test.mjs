// node --test tests/*.test.mjs   (multiplayer logic: rooms, smoothing, voice range, visibility)
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomsFor, Track, VoiceGate, visible, voiceGain, cleanName } from '../web/mp/logic.js';
import { MP } from '../web/mp/config.js';

test('player in the middle of a square is in one room', () => {
  assert.deepEqual([...roomsFor(250, 250, 500, 20, 40)], ['0_0']);
});
test('player near an edge also joins the neighbour, and keeps it with hysteresis', () => {
  const r = roomsFor(490, 250, 500, 20, 40);
  assert.deepEqual([...r].sort(), ['0_0', '1_0']);
  assert.ok(!roomsFor(470, 250, 500, 20, 40).has('1_0'), 'fresh: 30 m away is too far');
  assert.ok(roomsFor(470, 250, 500, 20, 40, r).has('1_0'), 'already joined: kept until 40 m');
  assert.ok(!roomsFor(455, 250, 500, 20, 40, r).has('1_0'), 'left beyond 40 m');
});
test('corner joins four rooms', () => { assert.equal(roomsFor(499, 499, 500, 20, 40).size, 4); });

test('track interpolates between samples and drops late ones', () => {
  const t = new Track(0.1);
  t.push(1, 0, { x: 0, y: 0, h: 0, v: 0 });
  t.push(2, 1, { x: 10, y: 0, h: 0, v: 1 });
  assert.equal(t.push(1, 1.5, { x: 99, y: 0, h: 0, v: 0 }), false, 'out of order dropped');
  assert.equal(t.push(2, 1.5, { x: 99, y: 0, h: 0, v: 0 }), false, 'duplicate dropped');
  const s = t.sample(0.6);                       // drawn at 0.5
  assert.ok(Math.abs(s.x - 5) < 1e-9);
  assert.equal(t.sample(5).x, 10, 'holds the last state');
});
test('heading interpolates the short way round', () => {
  const t = new Track(0);
  t.push(1, 0, { x: 0, y: 0, h: 3.0, v: 0 }); t.push(2, 1, { x: 0, y: 0, h: -3.0, v: 0 });
  const h = t.sample(0.5).h;
  assert.ok(Math.abs(Math.abs(h) - Math.PI) < 0.05, 'goes through pi, not through 0: ' + h);
});

test('voice connects at 4 m and survives boundary wobble', () => {
  const g = new VoiceGate(MP);
  assert.equal(g.update(5, 0.1), false);
  assert.equal(g.update(3.9, 0.1), true);
  for (let k = 0; k < 20; k++) assert.equal(g.update(k % 2 ? 6.5 : 5.5, 0.1), true, 'wobbling around 6 m keeps the line');
  g.update(5, 0.1);                               // back inside: the out-of-range clock resets
  let on = true; for (let k = 0; k < 29; k++) on = g.update(7, 0.1);
  assert.equal(on, true, 'not yet after 2.9 s');
  assert.equal(g.update(7, 0.2), false, 'off after 3 s out of range');
});
test('visibility has hysteresis', () => {
  assert.equal(visible(false, 11, 10, 12), false);
  assert.equal(visible(false, 9, 10, 12), true);
  assert.equal(visible(true, 11, 10, 12), true);
  assert.equal(visible(true, 12.5, 10, 12), false);
});
test('voice volume: full to 1 m, silent at 3 m', () => {
  assert.equal(voiceGain(0.5, 1, 3), 1); assert.equal(voiceGain(2, 1, 3), 0.5); assert.equal(voiceGain(3.5, 1, 3), 0);
});
test('names are cleaned', () => { assert.equal(cleanName('  <b>Sarath</b>\n'), 'bSarath/b'); assert.equal(cleanName('x'.repeat(40)).length, 24); });
