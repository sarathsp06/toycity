// call sessions (web/mp/call.js) between several players over the loopback transport, on a fake clock
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCall, RING_MS, RETRY_MS } from '../web/mp/call.js';
import { createLoopback } from '../web/mp/transport.js';

function world(ids, { agents = [], novoice = [] } = {}) {
  const hub = createLoopback(), present = new Set(ids), w = { hub, t: 0, present, p: {}, ev: {} };
  for (const id of ids) {
    const tr = hub.transport(id), ev = w.ev[id] = [];
    const c = w.p[id] = createCall({ self: id, send: tr.signal, now: () => w.t,
      peers: { has: x => x !== id && present.has(x), canTalk: x => present.has(x) && !novoice.includes(x) },
      voice: () => !novoice.includes(id), autoAnswer: () => agents.includes(id) });
    tr.onSignal((m, from) => c.receive(m, from));
    c.on((e, a, b) => { if (e !== 'change') ev.push([e, a, b]); });
  }
  w.flush = () => hub.flush();
  w.advance = ms => { w.t += ms; for (const id of ids) if (present.has(id)) w.p[id].tick(); w.flush(); };
  w.members = id => [...w.p[id].members].sort();
  w.answer = id => { const inv = w.ev[id].filter(e => e[0] === 'invite').pop(); w.p[id].accept(inv[2]); w.flush(); };
  return w;
}

test('ring, answer: both are members, no retry once it rings', () => {
  const w = world(['a', 'b']);
  assert.equal(w.p.a.ring('b'), true); w.flush();
  assert.deepEqual([...w.p.a.ringing.keys()], ['b']);
  assert.equal(w.ev.b[0][0], 'invite');
  w.advance(RETRY_MS + 500);
  assert.equal(w.ev.b.filter(e => e[0] === 'invite').length, 1, 'acknowledged: not sent again');
  w.answer('b');
  assert.deepEqual(w.members('a'), ['b']); assert.deepEqual(w.members('b'), ['a']);
  assert.equal(w.p.a.ringing.size, 0); assert.equal(w.p.a.id, w.p.b.id);
});
test('a lost invite is sent once more after ~2 s', () => {
  const w = world(['a', 'b']);
  let lost = 0; w.hub.drop = (f, t, m) => m.t === 'invite' && lost++ === 0;
  w.p.a.ring('b'); w.flush();
  assert.equal(w.ev.b.length, 0);
  w.advance(RETRY_MS + 100);
  assert.equal(w.ev.b.filter(e => e[0] === 'invite').length, 1);
  w.advance(RETRY_MS * 2); w.answer('b');
  assert.deepEqual(w.members('a'), ['b']);
});
test('nobody answers: ringing stops after the ring time and the call ends', () => {
  const w = world(['a', 'b']);
  w.p.a.ring('b'); w.flush();
  w.advance(RING_MS + 1000);
  assert.deepEqual(w.ev.a.map(e => e[0]), ['noAnswer']);
  assert.equal(w.p.a.active, false);
  assert.ok(w.ev.b.some(e => e[0] === 'cancel'), 'their toast goes too');
});
test('decline and hang up before an answer', () => {
  const w = world(['a', 'b', 'c']);
  w.p.a.ring('b'); w.flush();
  w.p.b.decline(w.ev.b[0][2]); w.flush();
  assert.equal(w.ev.a[0][0], 'declined'); assert.equal(w.p.a.active, false);
  w.p.a.ring('c'); w.flush(); w.p.a.leave(); w.flush();
  assert.ok(w.ev.c.some(e => e[0] === 'cancel'));
  assert.equal(w.p.c.incoming.size, 0);
});
test('three-way: ringing someone while in a call adds them, and every list converges', () => {
  const w = world(['a', 'b', 'c']);
  w.p.a.ring('b'); w.flush(); w.answer('b');
  w.p.b.ring('c'); w.flush(); w.answer('c');
  assert.deepEqual(w.members('a'), ['b', 'c']);
  assert.deepEqual(w.members('b'), ['a', 'c']);
  assert.deepEqual(w.members('c'), ['a', 'b']);
});
test('membership drift mends: a lost join is repaired by the member lists', () => {
  const w = world(['a', 'b', 'c']);
  w.p.a.ring('b'); w.flush(); w.answer('b');
  w.hub.drop = (f, t, m) => f === 'c' && t === 'a' && m.t === 'join';   // a never hears c join directly
  w.p.b.ring('c'); w.flush(); w.answer('c'); w.hub.drop = null; w.flush();
  assert.deepEqual(w.members('a'), ['b', 'c']);
  assert.deepEqual(w.members('c'), ['a', 'b']);
});
test('leave: the others keep their call; a player who leaves is not merged back', () => {
  const w = world(['a', 'b', 'c']);
  w.p.a.ring('b'); w.flush(); w.answer('b'); w.p.a.ring('c'); w.flush(); w.answer('c');
  w.p.c.leave(); w.flush();
  assert.equal(w.p.c.active, false);
  assert.deepEqual(w.members('a'), ['b']); assert.deepEqual(w.members('b'), ['a']);
  assert.ok(w.ev.a.some(e => e[0] === 'left' && e[1] === 'c'));
  w.p.b.leave(); w.flush();
  assert.equal(w.p.a.active, false, 'alone: the call ends');
});
test('a player who times out of presence leaves the call', () => {
  const w = world(['a', 'b', 'c']);
  w.p.a.ring('b'); w.flush(); w.answer('b'); w.p.a.ring('c'); w.flush(); w.answer('c');
  w.present.delete('c'); w.p.a.peerLeft('c'); w.p.b.peerLeft('c'); w.flush();
  assert.deepEqual(w.members('a'), ['b']); assert.deepEqual(w.members('b'), ['a']);
});
test('an agent answers by itself, and when busy declines instead of dropping its call', () => {
  const w = world(['a', 'bot', 'c'], { agents: ['bot'] });
  w.p.a.ring('bot'); w.flush();
  assert.deepEqual(w.members('bot'), ['a']); assert.deepEqual(w.members('a'), ['bot']);
  w.p.c.ring('bot'); w.flush();
  assert.deepEqual(w.members('bot'), ['a'], 'still with a');
  const d = w.ev.c.find(e => e[0] === 'declined'); assert.ok(d && d[2].busy);
  assert.equal(w.p.c.active, false);
  // asked into the call it is already in (a merge from another member): it simply joins them
  w.p.a.ring('c'); w.flush(); w.answer('c');
  assert.deepEqual(w.members('bot'), ['a', 'c']);
});
test('no voice: declined at once, and noted as missed', () => {
  const w = world(['a', 'b'], { novoice: ['b'] });
  assert.equal(w.p.a.ring('b'), false, 'never offered');
  w.p.b.receive({ t: 'invite', call: 'x', members: [] }, 'a'); w.flush();   // an older game rings anyway
  assert.equal(w.ev.b[0][0], 'missed');
});
test('junk messages are ignored', () => {
  const w = world(['a', 'b']);
  for (const m of [null, 5, {}, { t: 'invite' }, { t: 'invite', call: 'x', members: 'no' }, { t: 'join', call: 'nope' }]) w.p.a.receive(m, 'b');
  assert.equal(w.p.a.active, false); assert.equal(w.ev.a.length, 0);
});
