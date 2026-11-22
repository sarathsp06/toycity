// Call sessions: who is in my call, who is being rung, and the messages that keep that the same on
// every side. Pure (no DOM, no timers of its own): the adapter (index.js) injects how to send, the
// clock and who is around, calls tick() about once a second, and draws toasts from the events.
// Tested by tests/mp-call.test.mjs over the loopback transport.
//
//   const c = createCall({ self, send(id, msg), now(), peers: { has(id), canTalk(id) }, voice(), autoAnswer() })
//   c.ring(id) c.accept(callId) c.decline(callId) c.leave() c.receive(msg, from) c.peerLeft(id) c.tick()
//   c.on((event, a, b) => …) -> unsubscribe. Events: change; invite (from, callId); cancel (callId);
//     noAnswer (id); declined (id, msg); left (id); missed (from: rang me while I had no voice)
//
// Messages (the `call` data-channel action, straight to one player):
//   invite  { call, members }  ring someone; members: who is already in it, so they join them all
//   ringing { call }           "your invite arrived" (an invite with no answer at all is sent once more)
//   join    { call, members }  I am in; members: who I think is in it
//   members { call, members }  my member list changed: everyone merges it into theirs
//   decline { call, novoice?, busy? }   not now; no voice at all; already in another call
//   leave   { call }           I hung up (or stopped ringing you)
// Older games ignore ringing and members, and the members field of join.
export const RING_MS = 25000, RETRY_MS = 2000;

export function createCall({ self, send, now = () => Date.now(), peers, voice = () => true, autoAnswer = () => false, ringMs = RING_MS, retryMs = RETRY_MS }) {
  let call = null;                 // { id, members: Set, ringing: Map id -> { at, acked, retried } , gone: Set }
  const incoming = new Map();      // callId -> { from, members, at }: invitations shown, not answered yet
  const handlers = new Set();
  const emit = (e, a, b) => { for (const f of handlers) { try { f(e, a, b); } catch (err) { console.warn('[call] handler', err); } } };
  const newId = () => Math.random().toString(36).slice(2);
  const list = () => [...call.members];
  // after any change: an empty call ends, and everyone hears about it
  function settle() {
    if (call && !call.members.size && !call.ringing.size) call = null;
    emit('change');
  }
  // tell every member who I have, so lists that drifted apart (a lost join, a merge) converge
  function broadcast() { if (call) for (const id of call.members) send(id, { t: 'members', call: call.id, members: list() }); }
  // the members of an invite or list that are still around (and not me, and not known to have left)
  const usable = ids => (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id !== self && peers.has(id) && !call?.gone.has(id));
  function enter(id, from, members) {
    call = { id, members: new Set(), ringing: new Map(), gone: new Set() };
    call.members.add(from); for (const m of usable(members)) call.members.add(m);
    for (const m of call.members) send(m, { t: 'join', call: id, members: list() });
  }
  function ring(id) {
    if (!peers.canTalk(id) || id === self) return false;
    if (call?.members.has(id) || call?.ringing.has(id)) return false;
    call ||= { id: newId(), members: new Set(), ringing: new Map(), gone: new Set() };
    call.gone.delete(id);
    send(id, { t: 'invite', call: call.id, members: list() });
    call.ringing.set(id, { at: now(), acked: false, retried: false });
    settle(); return true;
  }
  function accept(callId) {
    const inv = incoming.get(callId); if (!inv) return false;
    incoming.delete(callId);
    if (call && call.id !== callId) leave();
    if (call?.id === callId) { call.members.add(inv.from); for (const m of call.members) send(m, { t: 'join', call: callId, members: list() }); }
    else enter(callId, inv.from, inv.members);
    settle(); return true;
  }
  function decline(callId, why) {
    const inv = incoming.get(callId); if (!inv) return;
    incoming.delete(callId); send(inv.from, { t: 'decline', call: callId, ...why });
  }
  function leave() {
    if (!call) return;
    for (const id of [...call.members, ...call.ringing.keys()]) send(id, { t: 'leave', call: call.id });
    call = null; settle();
  }
  function invited(m, from) {
    const known = incoming.get(m.call);
    if (!voice()) { send(from, { t: 'decline', call: m.call, novoice: 1 }); emit('missed', from); return; }   // an older game may still ring me
    send(from, { t: 'ringing', call: m.call });
    // already in that very call (their list missed me, or a retry): just make sure they have me
    if (call?.id === m.call) { call.ringing.delete(from); call.members.add(from); send(from, { t: 'join', call: m.call, members: list() }); broadcast(); settle(); return; }
    if (known) return;   // the same invitation again (a retry): its toast is still up
    if (autoAnswer()) {   // a voice agent picks up by itself, but never drops a call with people in it for another
      if (call?.members.size) { send(from, { t: 'decline', call: m.call, busy: 1 }); return; }
      if (call) leave();   // only ringing others: give that up
      enter(m.call, from, m.members); settle(); return;
    }
    incoming.set(m.call, { from, members: m.members, at: now() });
    emit('invite', from, m.call);
  }
  function receive(m, from) {
    if (!m || typeof m !== 'object' || typeof m.call !== 'string') return;
    if (m.members !== undefined && !Array.isArray(m.members)) return;
    if (m.t === 'invite') return invited(m, from);
    if (call?.id !== m.call) {   // not my call: they hung up before I answered
      if (m.t === 'leave' && incoming.get(m.call)?.from === from) { incoming.delete(m.call); emit('cancel', m.call); }
      return;
    }
    const r = call.ringing.get(from);
    if (m.t === 'ringing') { if (r) r.acked = true; return; }
    if (m.t === 'join') {
      call.ringing.delete(from); call.gone.delete(from);
      const had = call.members.size; call.members.add(from);
      for (const id of usable(m.members)) call.members.add(id);
      if (call.members.size !== had) broadcast();
    } else if (m.t === 'members') {
      if (call.gone.has(from) || !peers.has(from)) return;   // a list that crossed their leave
      const had = call.members.size; call.members.add(from); call.ringing.delete(from);   // (also mends a join that got lost)
      for (const id of usable(m.members)) { call.members.add(id); call.ringing.delete(id); }
      if (call.members.size !== had) broadcast();
    } else if (m.t === 'decline') { if (!call.ringing.delete(from)) return; emit('declined', from, m); }
    else if (m.t === 'leave') {
      call.ringing.delete(from); call.gone.add(from);
      if (call.members.delete(from)) { emit('left', from); broadcast(); }
    } else return;
    settle();
  }
  function peerLeft(id) {
    for (const [cid, inv] of incoming) if (inv.from === id) { incoming.delete(cid); emit('cancel', cid); }
    if (!call) return;
    call.ringing.delete(id);
    if (call.members.delete(id)) broadcast();
    settle();
  }
  // about once a second: ringing gives up after ringMs, an invite nobody acknowledged is sent once more
  function tick() {
    const t = now();
    for (const [cid, inv] of incoming) if (t - inv.at > ringMs) { incoming.delete(cid); emit('cancel', cid); }
    if (!call) return;
    let changed = false;
    for (const [id, r] of call.ringing) {
      if (t - r.at > ringMs) { call.ringing.delete(id); emit('noAnswer', id); changed = true; }
      else if (!r.acked && !r.retried && t - r.at > retryMs) { r.retried = true; send(id, { t: 'invite', call: call.id, members: list() }); }
    }
    if (changed) settle();
  }
  return {
    ring, accept, decline, leave, receive, peerLeft, tick,
    on(f) { handlers.add(f); return () => handlers.delete(f); },
    inCall: id => !!call?.members.has(id),
    get id() { return call?.id || null; },
    get active() { return !!call; },
    get members() { return call ? call.members : EMPTY; },
    get ringing() { return call ? call.ringing : EMPTY_MAP; },
    get incoming() { return incoming; },
  };
}
const EMPTY = new Set(), EMPTY_MAP = new Map();
