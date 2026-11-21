// Multiplayer presence: who is around and where. Knows nothing about audio or map streaming.
//
// Discovery uses Nostr relays (through Trystero) only as a meeting point: a browser announces
// itself in the room of its 500 m square and the relays pass along WebRTC connection details.
// Positions and names then go directly between browsers over WebRTC data channels.
//
// Emits: peer(id) objects with { id, name, dist, shown, player } for the other systems to use, and
// exposes `connections` (id -> room) so a peer-to-peer voice transport can reuse the same links.
import * as THREE from 'three';
import { MP } from './config.js';
import { roomsFor, Track, visible, cleanName } from './logic.js';
import { ready as avatarsReady, makePlayer, setName, setLook, setVehicle, setCard, seatIn, animate, disposePlayer } from './players.js';
import { PASSENGER, seatLocal } from '../vehicle.js';

import { parseLook, myLook } from '../avatar.js';
const TRYSTERO = './trystero-nostr.js';   // patched local copy, see the file header

export async function createPresence({ scene, player, toRD, fromRD, slug, vehicle, body }) {
  const { joinRoom, selfId } = await import(TRYSTERO);
  // Relay fallback (TURN): when two players' networks block a direct connection (mobile data, many
  // offices), the WebRTC traffic goes through Cloudflare's relay instead. Short-lived credentials come
  // from a tiny Worker (toycity-turn); without them we fall back to direct connections only.
  // Only a few relay addresses: every one is gathered before an offer is sent, so a long list slows
  // down connecting (UDP 3478 is quickest; TLS on 443 gets through strict firewalls).
  const iceServers = await fetch(MP.iceUrl).then(r => r.ok ? r.json() : null).then(d => d?.iceServers?.map(s => ({
    ...s, urls: [].concat(s.urls).filter(u => /^stun:.*:3478$|^turn:.*:3478\?transport=udp$|^turns:.*:443\?transport=tcp$/.test(u)) }))).catch(() => null);
  await avatarsReady;

  const roomConfig = { appId: MP.appId, relayUrls: MP.relays, relayRedundancy: MP.relays.length, ...(iceServers ? { rtcConfig: { iceServers } } : {}) };
  const look = myLook();
  let myName = cleanName(localStorage.getItem('toycity.name')) || 'Visitor ' + (100 + Math.floor(Math.random() * 900));
  let myMic = false;
  let seq = 0, sendT = 0, lastSent = null, roomT = 0, lastCar = '', lastExtra = '';
  const rooms = new Map();          // key -> { room, send }
  const peers = new Map();          // id -> peer
  const listeners = { leave: [], room: [], call: [] };

  function peer(id) {
    let p = peers.get(id);
    if (!p) peers.set(id, p = { id, rooms: new Set(), track: new Track(MP.interpDelay), last: 0, name: '', shown: false, player: null, dist: Infinity });
    return p;
  }
  // the name tag over someone's head says when their microphone is off, so silence is explained
  const tag = p => (p.name || 'Visitor') + (p.mic ? '' : ' 🔇');
  function join(key) {
    const room = joinRoom(roomConfig, `nl:${key}`);   // one world for every region: the room is the RD square, never the map name
    const [send, receive] = room.makeAction('st');
    receive((d, id) => {
      if (!Array.isArray(d) || d.length < 6) return;
      const [s, x, y, h, v, n, look, micOn, car, cardLevel, pose, up] = d;
      if (![s, x, y, h, v].every(Number.isFinite)) return;
      const p = peer(id); p.rooms.add(key);
      p.last = performance.now() / 1000;
      p.track.push(s, p.last, { x, y, h, v });
      const name = cleanName(n), mic = micOn === 1;
      if ((name && name !== p.name) || mic !== p.mic) { p.name = name || p.name; p.mic = mic; if (p.player) setName(p.player, tag(p)); }
      const l = parseLook(look) ? look : 'classic';
      if (l !== p.look) { p.look = l; if (p.player) setLook(p.player, l); }
      const c = typeof car === 'string' && /^[a-z0-9_]{1,12}:[0-9a-f]{1,6}$/.test(car) ? car : '';   // "model:colour" while driving
      if (c !== p.car) { p.car = c; if (p.player) setVehicle(p.player, c, vehicle?.make); }
      // their card (1 yellow, 2 red), whether they are flying (1) or lying (2) after being hit, and how high
      p.card = [0, 1, 2].includes(cardLevel) ? cardLevel : 0; p.pose = [0, 1, 2, 3].includes(pose) ? pose : 0;
      p.up = Number.isFinite(up) ? Math.max(0, Math.min(20, up)) : 0;
    });
    // call invitations and answers go straight to one player (see index.js)
    const [sendCall, receiveCall] = room.makeAction('call');
    receiveCall((m, id) => { if (m && typeof m === 'object') for (const f of listeners.call) f(m, id); });
    room.onPeerJoin(id => { const p = peer(id); p.rooms.add(key); p.last ||= performance.now() / 1000; lastSent = null; });   // say hello right away
    room.onPeerLeave(id => { const p = peers.get(id); if (p) { p.rooms.delete(key); if (!p.rooms.size) drop(p); } });
    rooms.set(key, { room, send, sendCall });
    for (const f of listeners.room) f(key, room);
  }
  function leave(key) {
    const r = rooms.get(key); if (!r) return;
    r.room.leave(); rooms.delete(key);
    for (const p of [...peers.values()]) { p.rooms.delete(key); if (!p.rooms.size) drop(p); }
  }
  function drop(p) {
    for (const f of listeners.leave) f(p);
    if (p.player) disposePlayer(p.player);
    peers.delete(p.id);
  }

  // the car nearest to x, z within 5 m: mine, or another player's
  function carNear(x, z, not) {
    let best = null, bd = 5;
    const me = vehicle?.mine; if (me && Math.hypot(me.x - x, me.z - z) < bd) { bd = Math.hypot(me.x - x, me.z - z); best = me; }
    for (const q of peers.values()) {
      if (q.id === not || !q.car || !q.player || q.player.inside) continue;
      const g = q.player.group.position, d = Math.hypot(g.x - x, g.z - z);
      if (d < bd) { bd = d; best = { model: q.car.split(':')[0], x: g.x, z: g.z, h: q.player.group.rotation.y }; }
    }
    return best;
  }
  function update(dt, speed) {
    const now = performance.now() / 1000;
    const [X, Y] = toRD(player.position.x, player.position.z);
    if ((roomT -= dt) <= 0) {
      roomT = 0.5;
      const want = roomsFor(X, Y, MP.roomSize, MP.roomJoinEdge, MP.roomLeaveEdge, new Set(rooms.keys()));
      for (const k of want) if (!rooms.has(k)) join(k);
      for (const k of [...rooms.keys()]) if (!want.has(k)) leave(k);
    }
    // 10 updates a second while moving, one a second standing still, and at once after a change
    sendT -= dt;
    const extra = [body?.card || 0, body?.pose || 0, body?.y || 0], ek = extra.join();
    if ((vehicle?.shared || '') !== lastCar || ek !== lastExtra) { lastCar = vehicle?.shared || ''; lastExtra = ek; lastSent = null; }
    if (!lastSent || (sendT <= 0 && (speed > 0.05 || extra[1] === 1 || now - lastSent >= 1 / MP.idleHz))) {
      const state = [++seq, +X.toFixed(2), +Y.toFixed(2), +player.rotation.y.toFixed(3), +speed.toFixed(2), myName, look, myMic ? 1 : 0, vehicle?.shared || '', ...extra];
      for (const r of rooms.values()) r.send(state);
      sendT = 1 / MP.sendHz; lastSent = now;
    }
    for (const p of [...peers.values()]) {
      if (p.last && now - p.last > MP.peerTimeout) { drop(p); continue; }
      const s = p.track.sample(now); if (!s) continue;
      p.speed = s.v;
      p.dist = Math.hypot(s.x - X, s.y - Y);
      const show = visible(p.shown, p.dist, MP.showWithin, MP.hideBeyond);
      if (show && !p.player) { p.player = makePlayer(p.id, tag(p), p.look); scene.add(p.player.group); if (p.car) setVehicle(p.player, p.car, vehicle?.make); }
      if (p.player) {
        p.player.group.visible = show && p.pose !== 3;   // 3: at home, inside the house
        const [x, z] = fromRD(s.x, s.y); p.player.group.position.set(x, 0.15 + (p.up || 0), z); p.player.group.rotation.y = s.h;
        setCard(p.player, p.card || 0, p.pose || 0);
        // a passenger ("ride"): sit them in the car they are in, beside its driver, so the driver sees them
        if (p.player.inside) {
          const host = carNear(x, z, p.id);
          if (host) {
            const [along, across] = PASSENGER[host.model] || PASSENGER.suv, [lx, lz] = seatLocal(host.model, along, -across);
            const c = Math.cos(host.h), sn = Math.sin(host.h);
            p.player.group.position.set(host.x + lx * c + lz * sn, 0.15, host.z - lx * sn + lz * c); p.player.group.rotation.y = host.h;
          }
          seatIn(p.player, host?.model || null);
        }
        // far-away people still walk, but their animation only needs updating a few times a second
        if (show && (p.dist < 80 || (p.animT = (p.animT || 0) + dt) > 0.2)) { animate(p.player, s.v, p.dist < 80 ? dt : p.animT); p.animT = 0; }
      }
      p.shown = show;
    }
  }

  return {
    selfId, peers, update,
    get name() { return myName; },
    setMic(on) { myMic = !!on; lastSent = null; },
    setName(n) { n = cleanName(n); if (!n) return; myName = n; localStorage.setItem('toycity.name', n); lastSent = null; },
    // for a peer-to-peer voice transport: the same WebRTC connection, always through one room
    roomFor(p) { const k = [...p.rooms].sort().find(k => rooms.has(k)); return k && rooms.get(k).room; },
    sendTo(id, msg) { const p = peers.get(id); const k = p && [...p.rooms].sort().find(k => rooms.has(k)); if (k) rooms.get(k).sendCall(msg, id); return !!k; },
    onCall(f) { listeners.call.push(f); },
    onRoom(f) { listeners.room.push(f); for (const [k, r] of rooms) f(k, r.room); },
    onLeave(f) { listeners.leave.push(f); },
    // a small room of its own, wherever you are on the map: a house uses one so knocks reach its residents
    channel(name) {
      const room = joinRoom(roomConfig, `toycity:${name}`), [send, receive] = room.makeAction('msg');
      return { send, onMessage: receive, peers: () => Object.keys(room.getPeers()), leave: () => room.leave() };
    },
  };
}
