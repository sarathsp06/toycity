// Rooms: a small group that meets by name, wherever its members are on the map (a house's knock
// room today; a rented meeting room later). Built over a raw channel (presence.channel(), or the
// loopback one in tests), so it is pure and tested by tests/mp-room.test.mjs.
//
//   const r = openRoom(channel, { id, name: () => myName, role: 'host' | 'guest' })
//   r.id  r.role  r.members: Map id -> { id, name, role }  r.peers() -> ids
//   r.onJoin(f) / r.onLeave(f) -> unsubscribe   f(member)
//   r.onMessage(f) -> unsubscribe               f(msg, from, member)
//   r.send(msg, to?)                            to: one id or a list; everyone when left out
//   r.leave()                                   closes the channel and drops every listener
//
// On joining, each side says hello ({ t: '_hi', name, role }) to the newcomer; messages whose t starts
// with '_' are the room's own and never reach onMessage. An older game says no hello: it is a member
// all the same, a nameless guest.
export function openRoom(channel, { id = '', name = () => '', role = 'guest' } = {}) {
  const members = new Map(), joins = new Set(), leaves = new Set(), msgs = new Set();
  let open = true;
  const fire = (set, ...a) => { for (const f of set) { try { f(...a); } catch (e) { console.warn('[room] handler', e); } } };
  const hello = to => channel.send({ t: '_hi', name: String(name() || '').slice(0, 40), role }, to);
  function member(pid) {
    let m = members.get(pid);
    if (!m) { members.set(pid, m = { id: pid, name: '', role: 'guest' }); fire(joins, m); }
    return m;
  }
  channel.onPeerJoin?.(pid => { if (!open) return; member(pid); hello(pid); });
  channel.onPeerLeave?.(pid => { const m = members.get(pid); if (!m) return; members.delete(pid); fire(leaves, m); });
  channel.onMessage((msg, from) => {
    if (!open || !msg || typeof msg !== 'object') return;
    const m = member(from);
    if (msg.t === '_hi') { m.name = String(msg.name || '').slice(0, 40); m.role = msg.role === 'host' ? 'host' : 'guest'; return; }
    if (typeof msg.t === 'string' && msg.t[0] === '_') return;
    fire(msgs, msg, from, m);
  });
  const sub = set => f => { set.add(f); return () => set.delete(f); };
  return {
    id, role, members,
    peers: () => channel.peers(),
    onJoin: sub(joins), onLeave: sub(leaves), onMessage: sub(msgs),
    send(msg, to) { if (open) channel.send(msg, to); },
    leave() { if (!open) return; open = false; channel.leave(); joins.clear(); leaves.clear(); msgs.clear(); members.clear(); },
    get open() { return open; },
  };
}
