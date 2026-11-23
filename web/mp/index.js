// Social layer: wires the independent systems together and draws their buttons.
//   presence.js  who is around, where, and their avatars   (no audio, no map; state.js is its wire codec)
//   call.js      call sessions: ringing, members, the messages that keep them in step (pure)
//   transport.js how my voice and call messages reach a player (the seam; p2p and loopback adapters)
//   voice.js     microphone, proximity and positional voice (talks to presence, via a transport)
//   room.js      named rooms with members and roles, over presence.channel() (home knocks)
//   ambience.js  birds, wind and traffic made in the browser (no networking at all)
// The map streaming in city.js knows none of this; it only calls start() and update().
// This file is the adapter between call.js and the screen: toasts, the call bar and window.__agentCall.
import { createPresence } from './presence.js';
import { createVoice } from './voice.js';
import { p2pTransport } from './transport.js';
import { createCall, RING_MS } from './call.js';
import { isPassenger, carModel } from './state.js';
import { createAmbience } from './ambience.js';
import { MP } from './config.js';
import { PERSON } from '../solids.js';
import { footprintOf } from '../vehicle.js';
import * as THREE from 'three';

export async function start({ scene, camera, player, toRD, fromRD, slug, params, hud, surroundings, view, goToRD, find, solids, vehicle, body, knockDown, homes, ground, room }) {
  hud.innerHTML = `<button id="mpname" title="Change your name"></button>
    <button id="mpview" title="Switch between seeing through your eyes and from behind (V)"></button>
    <button id="mpsound" title="Birds, wind and traffic"></button>
    <button id="mpcalls" title="Whether others can call you (switch off to never be rung)"></button>
    <button id="mpmeet" title="Share a link to where you are standing; whoever opens it arrives here">📍 Meeting link</button>
    <button id="mppeople">Looking for people nearby…</button><div id="mplist" hidden></div>`;
  // the call panel and invitations sit at the bottom of the screen, where thumbs are
  const callBox = document.createElement('div'); callBox.id = 'mpcall'; callBox.hidden = true; document.body.append(callBox);
  const toasts = document.createElement('div'); toasts.id = 'mptoasts'; document.body.append(toasts);
  const $ = s => hud.querySelector(s);
  const presence = await createPresence({ scene, player, toRD, fromRD, slug, vehicle, body, ground, room });
  // a driver ran into you: their game sends where the car was going; yours plays the fall
  homes?.connect(presence);   // houses: knocks and residents (home.js)
  presence.onCall((m, id) => { if (m.t === 'hit' && Number.isFinite(m.vx) && Number.isFinite(m.vz) && presence.peers.get(id)?.car) knockDown?.(m); });
  // other people are solid: you walk around them, not through them
  solids?.live(() => [...presence.peers.values()].filter(p => p.player?.group.visible && p.dist < 20)
    .map(p => {
      const g = p.player.group.position;
      // someone driving is as big as their car, and carries its speed (a fast one wrecks a car it hits)
      if (isPassenger(p.car)) return { x: 1e9, z: 1e9, r: 0 };   // a passenger is inside a car, not in the way
      return p.car ? { ...footprintOf(carModel(p.car), g.x, g.z, p.player.group.rotation.y), v: p.speed || 0 } : { x: g.x, z: g.z, r: PERSON.r, id: p.id };
    }));
  // Calls. The people near you are listed as "📞 Talk to …" buttons at the bottom of the screen; tapping
  // one (or the person themselves, or Talk in the people list) rings them. Only people in the same call
  // hear each other, at full volume wherever they stand. Ringing someone else while in a call adds them.
  // The microphone is on only while a call is connected.
  // The session itself is call.js; this is its adapter: messages go through the transport, and its
  // events become toasts, the call bar, the microphone and window.__agentCall.
  const transport = p2pTransport(presence);
  // AI agents (tools/mcp, names start with 🤖) have no voice: they are not offered for calls, and an
  // agent's game turns down a call at once instead of leaving the caller ringing
  // Capabilities: each player tells the others what it can do (presence: caps). 'v' = voice, it can hear
  // and talk. A browser has it unless calls are switched off in the menu; an AI agent only if it joined
  // with a voice. Players without it are never offered for a call.
  const canTalk = p => !!p && (p.caps === undefined ? !(p.name || '').startsWith('🤖') : p.caps.includes('v'));
  const myCaps = () => (body?.caps ?? 'v');
  const call = createCall({ self: presence.selfId, send: transport.signal, now: () => performance.now(),
    peers: { has: id => presence.peers.has(id), canTalk: id => canTalk(presence.peers.get(id)) },
    voice: () => myCaps().includes('v'), autoAnswer: () => !!body?.autoAnswer });
  transport.onSignal((m, from) => { if (m?.t !== 'hit') call.receive(m, from); });
  const voice = createVoice({ camera, player, presence, transport, params, inCall: call.inCall, busy: () => call.members.size > 0,
    onMicLost: () => { presence.setMic(false); toast('🎙️ The microphone went away; trying it again', [], 4000); settle(); } });
  const nameOf = id => presence.peers.get(id)?.name || 'Visitor';
  function toast(text, buttons = [], ms = 8000) {
    const t = document.createElement('div'); t.className = 'toast'; t.append(text);
    for (const [label, fn] of buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { t.remove(); fn(); }; t.append(b); }
    toasts.append(t); if (ms) setTimeout(() => t.remove(), ms); return t;
  }
  const setMic = on => voice.setMic(on).then(v => presence.setMic(v)).catch(e => toast('Could not use the microphone: ' + (e.message || e)));
  function settle() {                    // after any change: match the mic to the call
    const want = call.members.size > 0;
    if (want !== voice.micOn) setMic(want);
    renderCall();
  }
  const ring = id => call.ring(id);
  const leave = () => call.leave();
  call.on((e, a, b) => {
    if (e === 'change') settle();
    else if (e === 'invite') {
      // someone in the same house: you are in the room together, so the call just connects
      if (presence.peers.get(a)?.inMyHouse && homes?.inside) { houseCall = true; call.accept(b); return; }
      const t = toast(`📞 ${nameOf(a)} wants to talk`, [['Answer', () => call.accept(b)], ['Not now', () => call.decline(b)]], RING_MS);
      t.classList.add('ring'); t.dataset.call = b;
    } else if (e === 'cancel') toasts.querySelectorAll(`.ring[data-call="${a}"]`).forEach(t => t.remove());   // they hung up before I answered
    else if (e === 'noAnswer') toast(`${nameOf(a)} didn't answer`, [], 4000);
    else if (e === 'declined') toast(b.novoice || b.agent ? `${nameOf(a)} can't talk: no voice.` : b.busy ? `${nameOf(a)} is in another call` : `${nameOf(a)} can't talk right now`, [], 4000);
    else if (e === 'left') toast(`${nameOf(a)} left the call`, [], 4000);
    else if (e === 'missed') (window.__agentCalls ||= []).push(nameOf(a));
  });
  presence.onLeave(p => call.peerLeft(p.id));
  // once a second, visible or not: rings time out and are retried, and in a hidden tab (no frames)
  // my voice still follows the call
  presence.onBeat(() => { call.tick(); houseBeat(); if (document.hidden) voice.route(); });
  // One call per house: everyone who can talk in the same house is in it, without ringing (the one
  // with the lower id starts it, so two people don't ring each other at once). Stepping outside leaves it.
  let houseCall = false;
  function houseBeat() {
    if (!homes?.inside || homes.busy) { if (houseCall && !homes?.busy) { houseCall = false; if (call.active) leave(); } return; }
    if (!myCaps().includes('v')) return;
    for (const p of presence.peers.values()) {
      if (!p.inMyHouse || !canTalk(p) || call.members.has(p.id) || call.ringing.has(p.id)) continue;
      if (call.active || presence.selfId < p.id) { houseCall = true; ring(p.id); }
    }
  }
  // for an AI agent with a voice (tools/mcp): call someone by name, hang up, and who is in the call
  window.__agentCall = {
    ring: name => { const p = [...presence.peers.values()].filter(p => canTalk(p) && p.dist < 60).find(p => (p.name || '').toLowerCase().includes(String(name).toLowerCase())); if (!p) return null; ring(p.id); return p.name; },
    leave: () => leave(), hangUp: () => leave(),
    mute: on => call.members.size ? setMic(!on).then(renderCall) : Promise.resolve(), get muted() { return !voice.micOn; },
    canTalk: id => canTalk(presence.peers.get(id)),
    get autoAnswer() { return !!body?.autoAnswer; },
    get members() { return [...call.members].map(nameOf); },
    get ringing() { return [...call.ringing.keys()].map(nameOf); },
  };
  const pill = (text, cls) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
  let callSig = '';
  function renderCall() {
    // rebuilt only when something visible changed, so a button is never swapped out under a finger
    const nearIds = [...presence.peers.values()].filter(p => p.dist <= MP.talkReach).map(p => p.id + p.name).sort();
    const sig = JSON.stringify([call.active && [...call.members].map(id => [id, nameOf(id), voice.talking(id)]), call.active && [...call.ringing.keys()], voice.micOn, nearIds]);
    if (sig === callSig) return; callSig = sig;
    // in a call: who is in it (lit while talking), who is being rung, Mute and Leave
    if (call.active) {
      const items = [...call.members].map(id => pill(nameOf(id), 'who' + (voice.talking(id) ? ' talking' : '')));
      for (const id of call.ringing.keys()) items.push(pill(`ringing ${nameOf(id)}…`, 'who ringing'));
      const mute = document.createElement('button'); mute.className = 'mute';
      mute.textContent = voice.micOn ? '🎙️ Mute' : '🔇 Muted'; mute.disabled = !call.members.size;
      mute.onclick = () => setMic(!voice.micOn).then(renderCall);
      const end = document.createElement('button'); end.textContent = call.members.size ? 'Leave' : 'Cancel'; end.className = 'end'; end.onclick = leave;
      callBox.replaceChildren('📞 ', ...items, mute, end);
    } else callBox.replaceChildren();
    // the people close to me that I could talk to, as buttons
    const near = [...presence.peers.values()].filter(p => p.dist <= MP.talkReach && canTalk(p) && myCaps().includes('v') && !call.members.has(p.id) && !call.ringing.has(p.id))
      .sort((a, b) => a.dist - b.dist).slice(0, 3);
    for (const p of near) { const b = document.createElement('button'); b.className = 'talk'; b.textContent = `📞 Talk to ${p.name || 'Visitor'}`; b.onclick = () => ring(p.id); callBox.append(b); }
    callBox.hidden = !callBox.childNodes.length;
  }
  // tapping a person on screen: the nearest one within a thumb's width of the tap
  const _v = new THREE.Vector3(); let down = null;
  addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; }, true);
  addEventListener('pointerup', e => {
    if (e.target.tagName !== 'CANVAS' || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    let best = null, bd = Math.max(28, innerWidth / 30);
    for (const p of presence.peers.values()) {
      if (!p.player?.group.visible) continue;
      for (const h of [0.9, 1.7]) {
        _v.copy(p.player.group.position).setY(p.player.group.position.y + h).project(camera);
        if (_v.z > 1) continue;
        const d = Math.hypot((_v.x + 1) / 2 * innerWidth - e.clientX, (1 - _v.y) / 2 * innerHeight - e.clientY);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (!best) return;
    e.stopImmediatePropagation();       // a tap on a person is not a "walk there"
    if (call.members.has(best.id) || !canTalk(best) || !myCaps().includes('v')) return;
    ring(best.id);
  }, true);
  const ambience = createAmbience({ ctx: voice.listener.context, surroundings });

  function render() {
    $('#mpname').textContent = '👤 ' + presence.name;
    $('#mpview').textContent = view?.eyes ? '🎥 From behind' : '👁️ My eyes';
    $('#mpsound').textContent = ambience.on ? '🔊 Sounds' : '🔈 Sounds off';
    $('#mpcalls').textContent = myCaps().includes('v') ? '📞 Calls on' : '📵 Calls off';
    const ps = [...presence.peers.values()], near = ps.filter(p => p.dist <= MP.nearby).length;
    if (!$('#mplist').hidden) list();
    $('#mppeople').textContent = !ps.length ? '👥 Nobody around yet'
      : `👥 ${near} nearby · ${ps.length} in this area` ;
    renderCall();
  }
  // change name in place: the button turns into a text box; Enter or leaving it saves, Escape cancels
  $('#mpname').onclick = () => {
    const b = $('#mpname'), inp = document.createElement('input');
    inp.value = presence.name; inp.maxLength = 24; inp.id = 'mpnameedit'; inp.setAttribute('aria-label', 'Your name');
    b.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = save => { if (done) return; done = true; if (save) presence.setName(inp.value); inp.replaceWith(b); render(); };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  };
  // tap the people count for everyone in this area, with a button to go and stand next to them
  function list() {
    const ps = [...presence.peers.values()].filter(p => Number.isFinite(p.dist)).sort((a, b) => a.dist - b.dist);
    $('#mplist').replaceChildren(...(ps.length ? ps.map(p => {
      const row = document.createElement('div'), go = document.createElement('button');
      row.textContent = `${p.name || 'Visitor'}${p.mic ? '' : ' 🔇'} · ${p.dist < 1000 ? Math.round(p.dist) + ' m' : (p.dist / 1000).toFixed(1) + ' km'} `;
      go.textContent = 'Go'; go.title = 'Jump to them'; go.onclick = () => { const s = p.track.sample(performance.now() / 1000); if (s && goToRD) goToRD(s.x, s.y); };
      // 🧭 Find: a route line to them, by footpath or by road, that follows them as they move
      if (find) {
        const nav = document.createElement('button'); nav.textContent = '🧭 Find'; nav.title = 'Show the way to them';
        nav.onclick = () => find({ id: p.id, name: p.name || 'Visitor', pos: () => { const q = presence.peers.get(p.id), s = q?.track.sample(performance.now() / 1000); return s ? fromRD(s.x, s.y) : null; } });
        row.append(nav);
      }
      row.append(go);
      if (canTalk(p) && myCaps().includes('v')) { const talk = document.createElement('button'); talk.textContent = call.members.has(p.id) ? 'In call' : '📞 Talk'; talk.disabled = call.members.has(p.id); talk.onclick = () => ring(p.id); row.append(talk); }
      return row;
    }) : [Object.assign(document.createElement('div'), { textContent: 'Nobody in this area yet. Share the link with a friend!' })]));
  }
  // a meeting link: this page, plus where I stand. Opening it puts you a few metres from that spot.
  $('#mpmeet').onclick = async () => {
    const [X, Y] = toRD(player.position.x, player.position.z);
    const url = new URL(location.pathname, location.origin);
    for (const k of ['place', 'region']) if (params.get(k)) url.searchParams.set(k, params.get(k));   // same place, same map
    url.searchParams.set('meet', X.toFixed(1) + ',' + Y.toFixed(1));
    if (navigator.share) { try { await navigator.share({ title: 'Meet me in Toy City', url: url.href }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url.href); toast('📍 Meeting link copied. Send it to your friends.', [], 4000); }
    catch { prompt('Copy this meeting link:', url.href); }
  };
  $('#mppeople').onclick = () => { const l = $('#mplist'); l.hidden = !l.hidden; if (!l.hidden) list(); };
  // who you are is not a choice (everyone gets a random person and outfit); how you see the world is
  $('#mpview').onclick = e => { if (view) view.eyes = !view.eyes; e.target.blur(); render(); };
  addEventListener('toycity:view', render);
  $('#mpsound').onclick = () => { ambience.toggle(); render(); };
  $('#mpcalls').onclick = () => { body?.setVoice?.(!myCaps().includes('v')); if (!myCaps().includes('v')) leave(); render(); renderCall(); };
  render();

  let hudT = 0, last = 0;
  return {
    presence, voice, ambience,
    get inCall() { return call.members.size > 0; }, call,
    update(_, speed) {
      // networking runs on wall-clock time: the game clock is capped per frame and slows down
      // when the tab is in the background, which would stretch every timeout
      const now = performance.now(), dt = Math.min((now - (last || now)) / 1000, 2); last = now;
      presence.update(dt, speed);
      voice.update(dt);
      ambience.update(dt);
      if ((hudT -= dt) <= 0) { hudT = 0.5; render(); }
    },
  };
}
