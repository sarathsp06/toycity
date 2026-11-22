// the transport seam (web/mp/transport.js): voice's send/stop decision over the loopback adapter
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback, createSender } from '../web/mp/transport.js';

function setup() {
  const hub = createLoopback(), a = hub.transport('a'); hub.transport('b'); hub.transport('c');
  const heard = []; hub.transport('b').onStream((from, s) => heard.push([from, s.id]));
  const call = new Set(), sender = createSender(a, id => call.has(id));
  return { hub, a, call, sender, heard, mic: { id: 'mic1' } };
}
test('sends only to call members, only with a mic, and once', () => {
  const { hub, a, call, sender, heard, mic } = setup();
  sender.step('b', mic); assert.equal(sender.sending('b'), false, 'not in a call');
  call.add('b');
  sender.step('b', null); assert.equal(sender.sending('b'), false, 'no mic yet');
  sender.step('b', mic); sender.step('b', mic); sender.step('c', mic);
  assert.equal(sender.sending('b'), true); assert.equal(sender.sending('c'), false);
  assert.deepEqual(heard, [['a', 'mic1']]); assert.deepEqual(a.sending(), ['b']);
  call.delete('b'); sender.step('b', mic);
  assert.equal(sender.sending('b'), false); assert.deepEqual(hub.log.map(l => l[0]), ['send', 'stop']);
});
test('a route that closes is stopped and sent again when it can', () => {
  const { hub, call, sender, mic } = setup();
  call.add('b'); sender.step('b', mic);
  hub.cut('a', 'b'); sender.step('b', mic);
  assert.equal(sender.sending('b'), false, 'no way to reach them now');
  hub.join('a', 'b'); sender.step('b', mic);
  assert.equal(sender.sending('b'), true);
  assert.deepEqual(hub.log.map(l => l[0]), ['send', 'stop', 'send']);
});
test('stopAll when the mic goes off; forget a player who left', () => {
  const { a, call, sender, mic } = setup();
  call.add('b'); call.add('c'); sender.step('b', mic); sender.step('c', mic);
  assert.deepEqual(a.sending().sort(), ['b', 'c']);
  sender.stopAll(mic); assert.deepEqual(a.sending(), []);
  sender.forget('b'); assert.equal(sender.sending('b'), false);
});
test('signals queue until flushed, can be lost, and unsubscribe', () => {
  const hub = createLoopback(), a = hub.transport('a'), b = hub.transport('b'), got = [];
  const off = b.onSignal((m, from) => got.push([m.t, from]));
  a.signal('b', { t: 'invite' }); assert.deepEqual(got, []);
  hub.flush(); assert.deepEqual(got, [['invite', 'a']]);
  hub.drop = () => true; a.signal('b', { t: 'lost' }); hub.flush(); hub.drop = null;
  off(); a.signal('b', { t: 'after' }); hub.flush();
  assert.deepEqual(got, [['invite', 'a']]);
  assert.equal(a.signal('nobody', { t: 'x' }), false);
});
