// Social layer: wires the independent systems together and draws their buttons.
//   presence.js  who is around, where, and their avatars   (no audio, no map)
//   voice.js     microphone, proximity and positional voice (talks to presence, via a transport)
//   ambience.js  birds, wind and traffic made in the browser (no networking at all)
// The map streaming in city.js knows none of this; it only calls start() and update().
import { createPresence } from './presence.js';
import { createVoice, p2pTransport } from './voice.js';
import { createAmbience } from './ambience.js';

export async function start({ scene, camera, player, toRD, fromRD, slug, params, hud, surroundings, useAvatar, view, goToRD }) {
  hud.innerHTML = `<button id="mpname" title="Change your name"></button>
    <button id="mpview" title="Switch between seeing through your eyes and from behind (V)"></button>
    <button id="mpmic" title="Microphone: people within about 10 metres hear you, louder when closer"></button>
    <button id="mpsound" title="Birds, wind and traffic"></button>
    <button id="mppeople">Looking for people nearby…</button><div id="mplist" hidden></div>`;
  const $ = s => hud.querySelector(s);
  const presence = await createPresence({ scene, player, toRD, fromRD, slug });
  const voice = createVoice({ camera, player, presence, transport: p2pTransport(presence), params });
  const ambience = createAmbience({ ctx: voice.listener.context, surroundings });

  function render() {
    $('#mpname').textContent = '👤 ' + presence.name;
    $('#mpview').textContent = view?.eyes ? '🎥 From behind' : '👁️ My eyes';
    $('#mpmic').textContent = voice.micOn ? '🎙️ Mic on' : '🎙️ Mic off';
    $('#mpmic').classList.toggle('on', voice.micOn);
    $('#mpsound').textContent = ambience.on ? '🔊 Sounds' : '🔈 Sounds off';
    const ps = [...presence.peers.values()], near = ps.filter(p => p.shown).length;
    if (!$('#mplist').hidden) list();
    $('#mppeople').textContent = !ps.length ? '👥 Nobody around yet'
      : `👥 ${near} nearby · ${ps.length} in this area` + (near && !voice.micOn ? ' · turn your mic on to talk' : '');
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
      row.append(go); return row;
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
