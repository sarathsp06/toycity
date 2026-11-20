// Social layer: wires the independent systems together and draws their buttons.
//   presence.js  who is around, where, and their avatars   (no audio, no map)
//   voice.js     microphone, proximity and positional voice (talks to presence, via a transport)
//   ambience.js  birds, wind and traffic made in the browser (no networking at all)
// The map streaming in city.js knows none of this; it only calls start() and update().
import { createPresence } from './presence.js';
import { createVoice, p2pTransport } from './voice.js';
import { createAmbience } from './ambience.js';
import { MP } from './config.js';
import * as THREE from 'three';

export async function start({ scene, camera, player, toRD, fromRD, slug, params, hud, surroundings, useAvatar, view, goToRD }) {
  hud.innerHTML = `<button id="mpname" title="Change your name"></button>
    <button id="mpview" title="Switch between seeing through your eyes and from behind (V)"></button>
    <button id="mpmic" title="Mute or unmute yourself in a call" hidden></button>
    <button id="mpsound" title="Birds, wind and traffic"></button>
    <button id="mppeople">Looking for people nearby…</button><div id="mplist" hidden></div>`;
  // the call panel and invitations sit at the bottom of the screen, where thumbs are
  const callBox = document.createElement('div'); callBox.id = 'mpcall'; callBox.hidden = true; document.body.append(callBox);
  const toasts = document.createElement('div'); toasts.id = 'mptoasts'; document.body.append(toasts);
  const $ = s => hud.querySelector(s);
  const presence = await createPresence({ scene, player, toRD, fromRD, slug });
  // Calls: tap a person (or Talk in the people list) to invite them. Voice only flows between people
  // in the same call, at full volume wherever they are. Inviting someone else adds them to the call.
  let call = null;                       // { id, members: Set of player ids }
  const voice = createVoice({ camera, player, presence, transport: p2pTransport(presence), params, inCall: id => !!call?.members.has(id) });
  const nameOf = id => presence.peers.get(id)?.name || 'Visitor';
  function toast(text, buttons = [], ms = 8000) {
    const t = document.createElement('div'); t.className = 'toast'; t.append(text);
    for (const [label, fn] of buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { t.remove(); fn(); }; t.append(b); }
    toasts.append(t); if (ms) setTimeout(() => t.remove(), ms); return t;
  }
  async function micOn() { if (!voice.micOn) try { presence.setMic(await voice.setMic(true)); } catch (e) { toast('Could not use the microphone: ' + (e.message || e)); } }
  function invite(id) {
    if (call?.members.has(id)) return;
    call ||= { id: Math.random().toString(36).slice(2), members: new Set() };
    presence.sendTo(id, { t: 'invite', call: call.id, members: [...call.members] });
    call.pending = id; micOn();
    toast(`Calling ${nameOf(id)}…`, [], 5000); renderCall();
  }
  function leave() {
    if (!call) return;
    for (const id of call.members) presence.sendTo(id, { t: 'leave', call: call.id });
    call = null; if (voice.micOn) voice.setMic(false).then(on => presence.setMic(on)); renderCall();
  }
  presence.onCall(async (m, from) => {
    if (m.t === 'invite') {
      toast(`📞 ${nameOf(from)} wants to talk`, [
        ['Accept', async () => {
          if (call && call.id !== m.call) leave();
          call = { id: m.call, members: new Set([from, ...(m.members || []).filter(id => presence.peers.has(id))]) };
          for (const id of call.members) presence.sendTo(id, { t: 'join', call: call.id });
          await micOn(); renderCall();
        }],
        ['No thanks', () => presence.sendTo(from, { t: 'decline', call: m.call })],
      ], 20000);
    } else if (m.t === 'join' && call?.id === m.call) { call.members.add(from); renderCall(); }
    else if (m.t === 'decline' && call?.id === m.call) { toast(`${nameOf(from)} can't talk right now`); if (!call.members.size) call = null; renderCall(); }
    else if (m.t === 'leave' && call?.id === m.call) {
      call.members.delete(from); toast(`${nameOf(from)} left the call`, [], 4000);
      if (!call.members.size) leave(); renderCall();
    }
  });
  presence.onLeave(p => { if (call?.members.delete(p.id)) { if (!call.members.size) leave(); renderCall(); } });
  function renderCall() {
    if (!call || !call.members.size) { callBox.hidden = true; $('#mpmic').hidden = true; return; }
    callBox.hidden = false; $('#mpmic').hidden = false;
    const people = [...call.members].map(id => {
      const s = voice._state.get(id), talking = (s?.audio?.level() || 0) > 0.02;
      const el = document.createElement('span'); el.className = 'who' + (talking ? ' talking' : ''); el.textContent = nameOf(id); return el;
    });
    const end = document.createElement('button'); end.textContent = 'Leave'; end.className = 'end'; end.onclick = leave;
    const hint = document.createElement('small'); hint.textContent = 'tap someone else to add them';
    callBox.replaceChildren('📞 ', ...people, hint, end);
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
    if (call?.members.has(best.id)) return;
    toast(`Talk to ${best.name || 'Visitor'}?`, [['📞 Call', () => invite(best.id)]], 6000);
  }, true);
  const ambience = createAmbience({ ctx: voice.listener.context, surroundings });

  function render() {
    $('#mpname').textContent = '👤 ' + presence.name;
    $('#mpview').textContent = view?.eyes ? '🎥 From behind' : '👁️ My eyes';
    $('#mpmic').textContent = voice.micOn ? '🎙️ Mute' : '🔇 Unmute';
    $('#mpmic').classList.toggle('on', voice.micOn);
    $('#mpsound').textContent = ambience.on ? '🔊 Sounds' : '🔈 Sounds off';
    const ps = [...presence.peers.values()], near = ps.filter(p => p.dist <= MP.nearby).length;
    if (!$('#mplist').hidden) list();
    $('#mppeople').textContent = !ps.length ? '👥 Nobody around yet'
      : `👥 ${near} nearby · ${ps.length} in this area` + (near && !call ? ' · tap someone to talk' : '');
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
      go.textContent = 'Go'; go.onclick = () => { const s = p.track.sample(performance.now() / 1000); if (s && goToRD) goToRD(s.x + 2, s.y + 2); };
      const talk = document.createElement('button'); talk.textContent = call?.members.has(p.id) ? 'In call' : '📞 Talk'; talk.disabled = !!call?.members.has(p.id); talk.onclick = () => invite(p.id);
      row.append(go, talk); return row;
    }) : [Object.assign(document.createElement('div'), { textContent: 'Nobody in this area yet. Share the link with a friend!' })]));
  }
  $('#mppeople').onclick = () => { const l = $('#mplist'); l.hidden = !l.hidden; if (!l.hidden) list(); };
  // who you are is not a choice (everyone gets a random person and outfit); how you see the world is
  $('#mpview').onclick = e => { if (view) view.eyes = !view.eyes; e.target.blur(); render(); };
  addEventListener('toycity:view', render);
  $('#mpmic').onclick = async () => { try { presence.setMic(await voice.setMic(!voice.micOn)); } catch (e) { alert('Could not use the microphone: ' + (e.message || e)); } render(); };
  $('#mpsound').onclick = () => { ambience.toggle(); render(); };
  render();

  let hudT = 0, last = 0;
  return {
    presence, voice, ambience,
    update(_, speed) {
      // networking runs on wall-clock time: the game clock is capped per frame and slows down
      // when the tab is in the background, which would stretch every timeout
      const now = performance.now(), dt = Math.min((now - (last || now)) / 1000, 2); last = now;
      presence.update(dt, speed);
      voice.update(dt);
      ambience.update(dt);
      $('#mpmic').style.setProperty('--lvl', Math.min(1, voice.micLevel() * 4).toFixed(2));
      if ((hudT -= dt) <= 0) { hudT = 0.5; render(); }
    },
  };
}
