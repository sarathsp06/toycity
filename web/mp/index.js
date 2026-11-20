// Social layer: wires the independent systems together and draws their buttons.
//   presence.js  who is around, where, and their avatars   (no audio, no map)
//   voice.js     microphone, proximity and positional voice (talks to presence, via a transport)
//   ambience.js  birds, wind and traffic made in the browser (no networking at all)
// The map streaming in city.js knows none of this; it only calls start() and update().
import { createPresence } from './presence.js';
import { createVoice, p2pTransport } from './voice.js';
import { createAmbience } from './ambience.js';

export async function start({ scene, camera, player, toRD, fromRD, slug, params, hud, surroundings }) {
  hud.innerHTML = `<button id="mpname" title="Change your name"></button>
    <button id="mpmic" title="Microphone: people within a few metres hear you"></button>
    <button id="mpsound" title="Birds, wind and traffic"></button>
    <span id="mppeople">Looking for people nearby…</span>`;
  const $ = s => hud.querySelector(s);
  const presence = await createPresence({ scene, player, toRD, fromRD, slug });
  const voice = createVoice({ camera, presence, transport: p2pTransport(presence), params });
  const ambience = createAmbience({ ctx: voice.listener.context, surroundings });

  function render() {
    $('#mpname').textContent = '👤 ' + presence.name;
    $('#mpmic').textContent = voice.micOn ? '🎙️ Mic on' : '🎙️ Mic off';
    $('#mpmic').classList.toggle('on', voice.micOn);
    $('#mpsound').textContent = ambience.on ? '🔊 Sounds' : '🔈 Sounds off';
    const ps = [...presence.peers.values()], near = ps.filter(p => p.shown).length;
    $('#mppeople').textContent = ps.length ? `${near} nearby · ${ps.length} in this area` : 'Nobody around yet';
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
  $('#mpmic').onclick = async () => { try { await voice.setMic(!voice.micOn); } catch (e) { alert('Could not use the microphone: ' + (e.message || e)); } render(); };
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
