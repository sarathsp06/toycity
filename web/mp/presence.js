// Multiplayer presence: who is around and where. Knows nothing about audio or map streaming.
//
// Discovery uses Nostr relays (through Trystero) only as a meeting point: a browser announces
// itself in the room of its 500 m square and the relays pass along WebRTC connection details.
// Positions and names then go directly between browsers over WebRTC data channels.
//
// Emits: peer(id) objects with { id, name, dist, shown, player, car, card, pose, up, caps } for the
// other systems to use, and linkFor(id) so a peer-to-peer voice transport reuses the same links.
// The state tuple on the wire is encoded and checked in state.js; channels become rooms in room.js.
import { MP } from './config.js';
import { roomsFor, Track, visible, cleanName } from './logic.js';
import { encodeState, decodeState, isInside, isSeated, carModel } from './state.js';
import { openRoom } from './room.js';
import { ready as avatarsReady, makePlayer, setName, setLook, setVehicle, setCard, seatIn, animate, disposePlayer } from './players.js';
import { PASSENGER, seatLocal } from '../vehicle.js';
import { ROAD } from '../solids.js';

import { parseLook, myLook } from '../avatar.js';
const TRYSTERO = './trystero-nostr.js';   // patched local copy, see the file header

export async function createPresence({ scene, player, toRD, fromRD, slug, vehicle, body, ground = () => 0, room = null }) {
  const { joinRoom, selfId } = await import(TRYSTERO);
  // Relay fallback (TURN): when two players' networks block a direct connection (mobile data, many
  // offices), the WebRTC traffic goes through Cloudflare's relay instead. Short-lived credentials come
  // from a tiny Worker (toycity-turn); without them we fall back to direct connections only.
  // Only a few relay addresses: every one is gathered before an offer is sent, so a long list slows
  // down connecting (UDP 3478 is quickest; TLS on 443 gets through strict firewalls).
  // A slow or dead Worker must not hold up the game: 3 s at most, then once more in the background
  // (Trystero reads roomConfig for every new connection, so connections made after that can use the relay.)
  const ice = () => { const ac = new AbortController(), t = setTimeout(() => ac.abort(), MP.iceTimeout * 1000);
    return fetch(MP.iceUrl, { signal: ac.signal }).then(r => r.ok ? r.json() : null).then(d => d?.iceServers?.map(s => ({
      ...s, urls: [].concat(s.urls).filter(u => /^stun:.*:3478$|^turn:.*:3478\?transport=udp$|^turns:.*:443\?transport=tcp$/.test(u)) }))).catch(() => null).finally(() => clearTimeout(t)); };
  const [iceServers] = await Promise.all([ice(), avatarsReady]);

  const roomConfig = { appId: MP.appId, relayUrls: MP.relays, relayRedundancy: MP.relays.length, ...(iceServers ? { rtcConfig: { iceServers } } : {}) };
  if (!iceServers) setTimeout(() => ice().then(s => { if (s) { roomConfig.rtcConfig = { iceServers: s }; console.log('[mp] relay servers fetched on retry'); } }), 5000);
  const look = myLook();
  let myName = cleanName(localStorage.getItem('toycity.name')) || 'Visitor ' + (100 + Math.floor(Math.random() * 900));
  let myMic = false;
  let seq = 0, sendT = 0, lastSent = null, roomT = 0, lastCar = '', lastParked = '', lastExtra = [0, 0, 0, 'v'];
  const rooms = new Map();          // key -> { room, send }
  const sent = new Map(), gone = []; let lastState = null;   // scratch for update(), so nothing is allocated per frame
  const firstRoom = p => { let best = null; for (const k of p.rooms) if (rooms.has(k) && (best === null || k < best)) best = k; return best; };
  const peers = new Map();          // id -> peer
  const listeners = { leave: new Set(), room: new Set(), call: new Set(), beat: new Set() };
  const sub = (set, f) => { set.add(f); return () => set.delete(f); };   // every on…() returns its unsubscribe
  const channels = new Map();       // name -> trystero room, for links to players outside my squares
  const st = {};                    // decodeState scratch, reused for every message

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
      const s = decodeState(d, st); if (!s) return;
      const p = peer(id); p.rooms.add(key);
      p.last = performance.now() / 1000;
      p.track.push(s.seq, p.last, { x: s.x, y: s.y, h: s.h, v: s.v });
      if ((s.name && s.name !== p.name) || s.mic !== p.mic) { p.name = s.name || p.name; p.mic = s.mic; if (p.player) setName(p.player, tag(p)); }
      const l = parseLook(s.look) ? s.look : 'classic';
      if (l !== p.look) { p.look = l; if (p.player) setLook(p.player, l); }
      if (s.car !== p.car) { p.car = s.car; if (p.player) setVehicle(p.player, s.car, vehicle?.make); }
      // their card, pose (state.js POSE), metres up or down, and what they can do ('v' voice)
      p.card = s.card; p.pose = s.pose; p.up = s.up; p.caps = s.caps;
      showParked(p, s.parked);
    });
    // call invitations and answers go straight to one player (see index.js)
    const [sendCall, receiveCall] = room.makeAction('call');
    receiveCall((m, id) => { if (m && typeof m === 'object') for (const f of listeners.call) { try { f(m, id); } catch (e) { console.warn('[mp] call handler', e); } } });
    room.onPeerJoin(id => { const p = peer(id); p.rooms.add(key); p.last ||= performance.now() / 1000; lastSent = null; });   // say hello right away
    room.onPeerLeave(id => { const p = peers.get(id); if (p) { p.rooms.delete(key); if (!p.rooms.size) drop(p); } });
    room.key = key; rooms.set(key, { room, send, sendCall });
    for (const f of listeners.room) f(key, room);
  }
  function leave(key) {
    const r = rooms.get(key); if (!r) return;
    r.room.leave(); rooms.delete(key);
    for (const p of [...peers.values()]) { p.rooms.delete(key); if (!p.rooms.size) drop(p); }
  }
  // the car a player got out of, standing where they left it (for everyone, not only them)
  function showParked(p, k) {
    const same = k && p.parked && k.model === p.parked.model && k.colour === p.parked.colour && Math.abs(k.x - p.parked.x) < 0.05 && Math.abs(k.y - p.parked.y) < 0.05 && Math.abs(k.h - p.parked.h) < 0.01;
    if (same) return;
    if (p.parkedMesh) { scene.remove(p.parkedMesh); p.parkedMesh = null; }
    p.parked = k || null;
    if (!k || !vehicle?.make) return;
    const [x, z] = fromRD(k.x, k.y), mesh = vehicle.make(k.model, k.colour);
    if (!mesh) return;
    mesh.position.set(x, ROAD, z); mesh.rotation.y = k.h;
    if (k.model === 'bike') { mesh.rotation.order = 'YXZ'; mesh.rotation.x = 0.16; }   // on its side stand
    scene.add(mesh); p.parkedMesh = mesh; p.parked = { ...k, sx: x, sz: z };
  }
  function drop(p) {
    showParked(p, null);
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
      if (d < bd) { bd = d; best = { model: carModel(q.car), x: g.x, z: g.z, h: q.player.group.rotation.y }; }
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
    const card = body?.card || 0, pose = body?.pose || 0, up = body?.y || 0, caps = body?.caps ?? 'v', car = vehicle?.shared || '';
    const parked = vehicle?.parked || null, pk = parked ? parked.model + parked.x.toFixed(1) + parked.y.toFixed(1) + parked.h.toFixed(3) : '';
    if (pk !== lastParked) { lastParked = pk; lastSent = null; }
    if (car !== lastCar || card !== lastExtra[0] || pose !== lastExtra[1] || up !== lastExtra[2] || caps !== lastExtra[3]) { lastCar = car; lastExtra = [card, pose, up, caps]; lastSent = null; }
    const extra = lastExtra;
    if (!lastSent || (sendT <= 0 && (speed > 0.05 || extra[1] === 1 || now - lastSent >= 1 / MP.idleHz))) {
      const state = encodeState({ seq: ++seq, x: X, y: Y, h: player.rotation.y, v: speed, name: myName, look, mic: myMic, car: vehicle?.shared || '', card: extra[0], pose: extra[1], up: extra[2], caps: extra[3], parked });
      // once to each player, over the one connection they are reached by (two who share several
      // squares would otherwise get, and relay, every message several times)
      sent.clear();
      for (const p of peers.values()) { const k = firstRoom(p); if (k && !sent.has(k)) sent.set(k, []); if (k) sent.get(k).push(p.id); }
      for (const [k, ids] of sent) rooms.get(k).send(state, ids);
      for (const [k, r] of rooms) if (!sent.has(k)) r.send(state);   // a room with nobody known yet: say hello to whoever turns up
      lastState = state;
      sendT = 1 / MP.sendHz; lastSent = now;
    }
    gone.length = 0;
    for (const p of peers.values()) {
      if (p.last && now - p.last > MP.peerTimeout) { gone.push(p); continue; }
      const s = p.track.sample(now); if (!s) continue;
      p.speed = s.v;
      p.dist = Math.hypot(s.x - X, s.y - Y);
      const show = visible(p.shown, p.dist, MP.showWithin, MP.hideBeyond);
      if (show && !p.player) { p.player = makePlayer(p.id, tag(p), p.look); scene.add(p.player.group); if (p.car) setVehicle(p.player, p.car, vehicle?.make); }
      if (p.player) {
        const [x, z] = fromRD(s.x, s.y);
        // inside a house nobody outside sees them; someone in the same house does, in its room (interior.js)
        const here = isInside(p.pose) && !!room?.contains(x, z);
        p.player.group.visible = show && (!isInside(p.pose) || here);
        // feet on the pavement: games that send the ground in their height already stand there, older ones send 0
        const seated = here && isSeated(p.pose, p.up); p.player.sitting = seated ? room.seatNear(x, z, 0.6) || { h: 0.45 } : null; p.inMyHouse = here;   // sitting: the seat they are on (its height)
        p.player.thinking = !!p.caps?.includes('t');   // an agent working out its reply: a thought bubble
        p.player.group.position.set(x, here ? room.floorY + (seated ? 0 : p.up || 0) : 0.15 + Math.max(p.up || 0, p.car ? 0 : ground(x, z)), z); p.player.group.rotation.y = s.h;
        setCard(p.player, p.card || 0, p.pose || 0, p.player.sitting ? 0 : p.up || 0);
        // in the air only while their height is changing and well above the ground: up is also the pavement (0.12 m) or the sofa they
        // stand on, and someone walking along a pavement must walk, not hang in a jump
        const upNow = p.player.sitting ? 0 : p.up || 0;
        if (Math.abs(upNow - (p.upLast ?? upNow)) > 0.03) p.airT = 0.35; else p.airT = Math.max(0, (p.airT || 0) - dt);
        p.upLast = upNow; p.player.air = p.airT > 0 && upNow > (here ? 0 : ground(x, z)) + 0.2;   // a kerb step is not a jump
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
    for (const p of gone) drop(p);
  }
  // The frame loop stops in a background tab (phone locked, app switched), so from there this keeps
  // me alive for the others once a second, and forgets players who went quiet, as the loop would
  // onBeat listeners run here every second, visible or not (calls time out, voice re-routes)
  const heartbeat = setInterval(() => {
    for (const f of listeners.beat) { try { f(); } catch (e) { console.warn('[mp] beat handler', e); } }
    if (document.visibilityState !== 'hidden' || !lastState) return;
    const now = performance.now() / 1000;
    if (now - lastSent >= 1 / MP.idleHz) { lastState[0] = ++seq; for (const r of rooms.values()) r.send(lastState); lastSent = now; }
    for (const p of [...peers.values()]) if (p.last && now - p.last > MP.peerTimeout) drop(p);
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lastSent = null; });   // say hello again at once

  const presence = {
    peers, update,
    get name() { return myName; },
    setMic(on) { myMic = !!on; lastSent = null; },
    setName(n) { n = cleanName(n); if (!n) return; myName = n; localStorage.setItem('toycity.name', n); lastSent = null; },
    selfId,
    // for a peer-to-peer voice transport (transport.js): the one WebRTC connection that reaches this
    // player, through my lowest square we share, else a channel we are both in; and whether it is still open
    linkFor(id) {
      const p = peers.get(id), k = p && firstRoom(p); if (k) return rooms.get(k).room;
      for (const room of channels.values()) if (room.getPeers()[id]) return room;
      return null;
    },
    isOpen: room => rooms.get(room.key)?.room === room || channels.get(room.chName) === room,
    roomFor(p) { const k = firstRoom(p); return k && rooms.get(k).room; },   // (older name; linkFor covers channels too)
    sendTo(id, msg) { const p = peers.get(id); const k = p && firstRoom(p); if (k) rooms.get(k).sendCall(msg, id); return !!k; },
    onCall: f => sub(listeners.call, f),
    onRoom(f) { for (const [k, r] of rooms) f(k, r.room); for (const [n, r] of channels) f('ch:' + n, r); return sub(listeners.room, f); },
    onLeave: f => sub(listeners.leave, f),
    onBeat: f => sub(listeners.beat, f),
    // a small room of its own, wherever you are on the map: a house uses one so knocks reach its residents
    channel(name) {
      const room = joinRoom(roomConfig, `toycity:${name}`), [send, receive] = room.makeAction('msg');
      if (channels.get(name) !== room) { room.chName = name; channels.set(name, room); for (const f of listeners.room) f('ch:' + name, room); }
      return { send, onMessage: receive, peers: () => Object.keys(room.getPeers()), onPeerJoin: f => room.onPeerJoin(f), onPeerLeave: f => room.onPeerLeave(f),
        leave: () => { if (channels.get(name) === room) channels.delete(name); room.leave(); } };
    },
    // the same, with names and roles (room.js): what home.js knocks through, and later meeting rooms
    room: (name, { role = 'guest' } = {}) => openRoom(presence.channel(name), { id: name, role, name: () => myName }),
  };
  return presence;
}
