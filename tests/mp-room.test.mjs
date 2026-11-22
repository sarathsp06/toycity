// rooms (web/mp/room.js) over the loopback channel: members with names and roles, messages, leaving
import test from 'node:test';
import assert from 'node:assert/strict';
import { openRoom } from '../web/mp/room.js';
import { createLoopback } from '../web/mp/transport.js';

test('a knock room: host and guest meet, say who they are, and talk', () => {
  const hub = createLoopback();
  const host = openRoom(hub.channel('h', 'home:1'), { id: 'home:1', name: () => 'Ada', role: 'host' });
  const joined = [], got = [];
  host.onJoin(m => joined.push(m.id));
  host.onMessage((m, from, who) => got.push([m.t, from, who.name, who.role]));
  const guest = openRoom(hub.channel('g', 'home:1'), { id: 'home:1', name: () => 'Bo' });
  hub.flush();
  assert.deepEqual(joined, ['g']);
  assert.deepEqual(host.peers(), ['g']); assert.deepEqual(guest.peers(), ['h']);
  assert.equal(guest.members.get('h').name, 'Ada'); assert.equal(guest.members.get('h').role, 'host');
  guest.send({ t: 'knock', name: 'Bo' }); hub.flush();
  assert.deepEqual(got, [['knock', 'g', 'Bo', 'guest']], 'the hello never reaches onMessage');
  const replies = []; guest.onMessage(m => replies.push(m.t));
  host.send({ t: 'coming' }, 'g'); hub.flush();
  assert.deepEqual(replies, ['coming']);
});
test('leaving tells the others and drops every listener', () => {
  const hub = createLoopback();
  const a = openRoom(hub.channel('a', 'r'), { name: () => 'A' }), b = openRoom(hub.channel('b', 'r'), { name: () => 'B' });
  hub.flush();
  const left = []; a.onLeave(m => left.push(m.id));
  const off = a.onMessage(() => assert.fail('unsubscribed'));
  off();
  b.send({ t: 'x' }); hub.flush();
  b.leave(); hub.flush();
  assert.deepEqual(left, ['b']); assert.equal(a.members.size, 0);
  assert.equal(b.open, false); b.send({ t: 'after' }); assert.equal(hub.flush(), 0, 'a closed room sends nothing');
});
test('an older game with no hello is still a member', () => {
  const hub = createLoopback();
  const r = openRoom(hub.channel('new', 'r'), { name: () => 'New' }), old = hub.channel('old', 'r');
  const seen = []; r.onMessage((m, from, who) => seen.push(who.name));
  old.onMessage(() => {}); hub.flush();
  old.send({ t: 'knock' }); hub.flush();
  assert.deepEqual(seen, ['']); assert.equal(r.members.get('old').role, 'guest');
});
