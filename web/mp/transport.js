// The transport seam: how my microphone and my call messages reach another player. Voice and calls
// only see this interface; which connection carries them is the transport's business.
//
//   send(id, stream) -> bool  start sending my microphone to this player (false: no way to reach them yet)
//   stop(id, stream)          stop sending it
//   routed(id) -> bool        the connection my voice to them went over is still open (false: send again)
//   onStream(f) -> unsub      f(id, stream) when a player's voice arrives
//   signal(id, msg) -> bool   a call message (call.js) to one player
//   onSignal(f) -> unsub      f(msg, from) for every call message
//
// Adapters:
//   p2pTransport(presence)  reuses the presence WebRTC connections (one per pair of players, no second
//                           link): the grid square we share, else a channel/room connection we share
//   createLoopback()        everything in memory, for tests: a hub of transports and channels
// An SFU adapter (LiveKit, see docs/multiplayer.md) would publish the microphone once and subscribe by id.
const log = (...a) => console.log('[voice]', ...a);
const short = id => String(id).slice(0, 6);

export function p2pTransport(presence) {
  const handlers = new Set(), route = new Map();   // id -> the connection my voice to them went over
  presence.onRoom((key, room) => room.onPeerStream((stream, id) => { for (const f of handlers) f(id, stream); }));
  presence.onLeave(p => route.delete(p.id));
  return {
    send(id, stream) {
      const r = presence.linkFor(id);
      if (!r) { log('cannot send to', short(id), ': no shared connection'); return false; }
      r.addStream(stream, id); route.set(id, r);
      const p = presence.peers.get(id);
      log('sending my mic to', short(id), p ? 'at ' + p.dist.toFixed(1) + ' m' : 'in a room', '; tracks', stream.getAudioTracks().map(t => t.readyState + (t.enabled ? '' : ' disabled')));
      return true;
    },
    stop(id, stream) { const r = route.get(id); if (r && presence.isOpen(r)) r.removeStream(stream, id); route.delete(id); log('stopped sending to', short(id)); },
    routed: id => { const r = route.get(id); return !!r && presence.isOpen(r); },
    onStream(f) { handlers.add(f); return () => handlers.delete(f); },
    signal: (id, msg) => presence.sendTo(id, msg),
    onSignal: f => presence.onCall(f),
  };
}

// Who my microphone goes to: each frame (and each heartbeat in a hidden tab) step() every player with
// my mic; it starts and stops sending as wants(id) and the routes change. No allocation per step.
export function createSender(transport, wants) {
  const on = new Map();   // id -> sending
  return {
    step(id, mic) {
      let s = on.get(id) || false;
      const want = !!mic && wants(id);
      if (s && (!want || !transport.routed(id))) { transport.stop(id, mic); s = false; }   // the route closed: send again over another
      if (want && !s) s = !!transport.send(id, mic);
      if (s !== (on.get(id) || false)) on.set(id, s);
    },
    stopAll(mic) { for (const [id, s] of on) if (s) { transport.stop(id, mic); on.set(id, false); } },
    sending: id => !!on.get(id),
    forget(id) { on.delete(id); },
  };
}

// In-memory adapter for tests. Messages queue until flush() (as on a network: nothing re-enters the
// sender), drop(from, to, msg) -> true loses one; cut(a, b) / join(a, b) change who reaches whom.
export function createLoopback() {
  const nodes = new Map(), queue = [], cuts = new Set(), rooms = new Map();
  const pair = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const node = id => nodes.get(id) || nodes.set(id, { streams: new Set(), signals: new Set(), out: new Map() }).get(id);
  const hub = {
    drop: null, log: [],
    reaches: (a, b) => nodes.has(a) && nodes.has(b) && !cuts.has(pair(a, b)),
    cut(a, b) { cuts.add(pair(a, b)); }, join(a, b) { cuts.delete(pair(a, b)); },
    flush() { let n = 0; while (queue.length && n++ < 10000) queue.shift()(); return n; },
    transport(self) {
      const me = node(self);
      return {
        send(id, stream) { if (!hub.reaches(self, id)) return false; me.out.set(id, stream); hub.log.push(['send', self, id]); for (const f of node(id).streams) f(self, stream); return true; },
        stop(id, stream) { me.out.delete(id); hub.log.push(['stop', self, id]); },
        routed: id => me.out.has(id) && hub.reaches(self, id),
        onStream(f) { me.streams.add(f); return () => me.streams.delete(f); },
        signal(id, msg) {
          if (!hub.reaches(self, id)) return false;
          const copy = JSON.parse(JSON.stringify(msg));   // what a data channel does to it
          queue.push(() => { if (hub.drop?.(self, id, copy)) return; for (const f of node(id).signals) f(copy, self); });
          return true;
        },
        onSignal(f) { me.signals.add(f); return () => me.signals.delete(f); },
        sending: () => [...me.out.keys()],
      };
    },
    // a raw channel as presence.channel() gives it: send(msg, to?), onMessage, peers, onPeerJoin/Leave, leave
    channel(self, name) {
      const members = rooms.get(name) || rooms.set(name, new Map()).get(name);
      const ch = { msg: null, join: null, leave: null };
      const others = () => [...members.keys()].filter(id => id !== self);
      for (const id of others()) queue.push(() => { members.get(id)?.join?.(self); ch.join?.(id); });
      members.set(self, ch);
      return {
        send(msg, to) { const copy = JSON.parse(JSON.stringify(msg)); for (const id of to ? [].concat(to) : others()) queue.push(() => members.get(id)?.msg?.(copy, self)); },
        onMessage(f) { ch.msg = f; }, onPeerJoin(f) { ch.join = f; }, onPeerLeave(f) { ch.leave = f; },
        peers: others,
        leave() { if (members.get(self) !== ch) return; members.delete(self); for (const id of others()) queue.push(() => members.get(id)?.leave?.(self)); },
      };
    },
  };
  return hub;
}
