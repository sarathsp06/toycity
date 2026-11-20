// Spatial voice: microphone, who I talk to, and where their voices come from.
// Knows peers only through presence (id, distance, avatar), and moves audio through a transport.
//
// Transport interface (swap for an SFU such as LiveKit without touching the rest):
//   send(peer, stream)  start sending my microphone to this peer
//   stop(peer, stream)  stop sending it
//   onStream(f)         f(peerId, stream) when a peer's voice arrives
// p2pTransport() below reuses the presence WebRTC connections, so there is never a second link.
import * as THREE from 'three';
import { MP } from './config.js';
import { VoiceGate } from './logic.js';

// Voice problems are hard to see, so the voice path logs every step: filter the console on [voice].
const log = (...a) => console.log('[voice]', ...a);
const short = id => String(id).slice(0, 6);

export function p2pTransport(presence) {
  const handlers = [];
  presence.onRoom((key, room) => room.onPeerStream((stream, id) => handlers.forEach(f => f(id, stream))));
  return {
    send(p, stream) {
      const r = presence.roomFor(p);
      if (!r) { log('cannot send to', short(p.id), ': no shared room'); return false; }
      r.addStream(stream, p.id); p._voiceRoom = r;
      log('sending my mic to', short(p.id), 'at', p.dist.toFixed(1), 'm; tracks', stream.getAudioTracks().map(t => t.readyState + (t.enabled ? '' : ' disabled')));
      return true;
    },
    stop(p, stream) { p._voiceRoom?.removeStream(stream, p.id); p._voiceRoom = null; log('stopped sending to', short(p.id)); },
    onStream(f) { handlers.push(f); },
  };
}

export function createVoice({ camera, player, presence, transport, params }) {
  // The ears sit on my character's head, turned the way the camera looks. (They used to be on the
  // camera, which floats metres above and behind: other voices were beyond their 10 m range.)
  const listener = new THREE.AudioListener(), ears = new THREE.Object3D();
  ears.position.y = 1.6; ears.userData.keep = true; ears.add(listener); (player || camera).add(ears);
  const _q = new THREE.Quaternion(), _p = new THREE.Quaternion();
  const ctx = listener.context;
  const out = ctx.createAnalyser(); out.fftSize = 512; listener.getInput().connect(out);   // what I actually hear
  const outBuf = new Float32Array(out.fftSize);
  const outLevel = () => { out.getFloatTimeDomainData(outBuf); let s = 0; for (const x of outBuf) s += x * x; return Math.sqrt(s / outBuf.length); };
  log('audio context', ctx.state, ctx.sampleRate + ' Hz');
  ctx.addEventListener('statechange', () => log('audio context', ctx.state));
  const unlock = () => { if (ctx.state !== 'running') ctx.resume().then(() => log('audio context resumed')).catch(e => log('resume failed', e)); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

  const state = new Map();          // peer id -> { sendGate, sending, audio }
  const st = id => state.get(id) || state.set(id, { sendGate: new VoiceGate(MP), sending: false, audio: null }).get(id);
  let mic = null, micLevel = null;

  transport.onStream(function onStream(id, stream) {
    const p = presence.peers.get(id);
    log('stream from', short(id), p ? 'at ' + p.dist.toFixed(1) + ' m' : '(unknown player, ignored)', 'tracks', stream.getAudioTracks().map(t => t.readyState + (t.muted ? ' muted' : '')));
    if (!p) return;
    // the stream can arrive a moment before its audio track does
    if (!stream.getAudioTracks().length) { stream.addEventListener('addtrack', () => onStream(id, stream), { once: true }); return; }
    const track = stream.getAudioTracks()[0];
    track.addEventListener('unmute', () => log('audio from', short(id), 'is flowing'));
    track.addEventListener('mute', () => log('audio from', short(id), 'paused (no packets)'));
    const s = st(id); stopHearing(s);
    // Chrome only delivers WebRTC audio to Web Audio when the stream also feeds a media element
    const el = new Audio(); el.srcObject = stream; el.muted = true;
    el.play().then(() => log('media element playing for', short(id))).catch(e => log('media element blocked for', short(id), e.name));
    const pa = new THREE.PositionalAudio(listener);
    pa.setMediaStreamSource(stream);
    pa.panner.panningModel = 'HRTF';
    pa.setDistanceModel('linear'); pa.setRefDistance(MP.voiceFull); pa.setMaxDistance(MP.voiceSilent); pa.setRolloffFactor(1);
    pa.position.y = 1.6;
    s.audio = { el, pa, level: levelMeter(ctx, stream), stream };
    // keep playing until the sender stops sending; distance only turns the volume down. (Dropping it
    // on my own distance check lost the voice for good when the two sides disagreed by a moment.)
    const ended = () => { if (s.audio?.stream === stream) stopHearing(s); };
    stream.addEventListener('removetrack', ended); track.addEventListener('ended', ended);
    log('hearing', short(id), '; audio context', ctx.state);
  });
  presence.onLeave(p => { const s = state.get(p.id); if (s) { stopHearing(s); state.delete(p.id); } });

  function stopHearing(s) { if (!s.audio) return; log('stopped hearing a player'); s.audio.pa.disconnect(); s.audio.pa.removeFromParent(); s.audio.el.srcObject = null; s.audio = null; }

  async function setMic(on) {
    if (on && !mic) {
      unlock();
      mic = params.get('fakemic') ? fakeMic(ctx) : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      micLevel = levelMeter(ctx, mic);
      log('mic on:', mic.getAudioTracks().map(t => t.label || 'track'), '; audio context', ctx.state);
    } else if (!on && mic) {
      for (const [id, s] of state) if (s.sending) { transport.stop(presence.peers.get(id) || { id }, mic); s.sending = false; }
      mic.getTracks().forEach(t => t.stop()); mic = null; micLevel = null; log('mic off');
    }
    return !!mic;
  }

  let logT = 0;
  function update(dt) {
    ears.quaternion.copy(ears.parent.getWorldQuaternion(_p).invert().multiply(camera.getWorldQuaternion(_q)));
    if ((logT -= dt) <= 0) {   // a summary every 5 s while anyone is near
      logT = 5;
      const near = [...presence.peers.values()].filter(p => p.dist < MP.voiceDisconnect);
      if (near.length) log('summary: context', ctx.state, '| mic', mic ? 'on, level ' + micLevel().toFixed(3) : 'off',
        '|', near.map(p => { const s = st(p.id); return `${short(p.id)} ${p.dist.toFixed(1)} m: sending ${s.sending}, hearing ${!!s.audio}${s.audio ? ', in ' + s.audio.level().toFixed(3) : ''}`; }).join('; '),
        '| out level', outLevel().toFixed(3));
    }
    for (const p of presence.peers.values()) {
      const s = st(p.id);
      const send = s.sendGate.update(p.dist, dt);
      if (send && mic && !s.sending) s.sending = transport.send(p, mic);
      if ((!send || !mic) && s.sending) { transport.stop(p, mic); s.sending = false; }
      if (s.audio) {
        if (p.player && s.audio.pa.parent !== p.player.group) p.player.group.add(s.audio.pa);
        if (p.player) p.player.speaking = s.audio.level();
      } else if (p.player) p.player.speaking = 0;
    }
  }

  return { _state: state, update, setMic, outLevel, get micOn() { return !!mic; }, micLevel: () => micLevel ? micLevel() : 0, listener,
    talkingTo: () => [...state.values()].filter(s => s.sending).length, hearing: () => [...state.values()].filter(s => s.audio).length };
}

// loudness 0..1 of a stream, for the "is talking" ring and my microphone button
function levelMeter(ctx, stream) {
  const a = ctx.createAnalyser(); a.fftSize = 512;
  try { ctx.createMediaStreamSource(stream).connect(a); } catch { return () => 0; }   // no audio track (yet)
  const buf = new Float32Array(a.fftSize);
  return () => { a.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; return Math.sqrt(s / buf.length); };
}

// test aid (?fakemic=1): a soft beeping tone instead of a real microphone
function fakeMic(ctx) {
  const o = ctx.createOscillator(), g = ctx.createGain(), lfo = ctx.createOscillator(), dst = ctx.createMediaStreamDestination();
  o.frequency.value = 440; lfo.frequency.value = 1.5; g.gain.value = 0;
  lfo.connect(g.gain); o.connect(g).connect(dst); o.start(); lfo.start();
  return dst.stream;
}
