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

export function p2pTransport(presence) {
  const handlers = [];
  presence.onRoom((key, room) => room.onPeerStream((stream, id) => handlers.forEach(f => f(id, stream))));
  return {
    send(p, stream) { const r = presence.roomFor(p); if (!r) return false; r.addStream(stream, p.id); p._voiceRoom = r; return true; },
    stop(p, stream) { p._voiceRoom?.removeStream(stream, p.id); p._voiceRoom = null; },
    onStream(f) { handlers.push(f); },
  };
}

export function createVoice({ camera, presence, transport, params }) {
  const listener = new THREE.AudioListener(); camera.add(listener);
  const ctx = listener.context;
  const unlock = () => { if (ctx.state !== 'running') ctx.resume(); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

  const state = new Map();          // peer id -> { sendGate, hearGate, sending, audio }
  const st = id => state.get(id) || state.set(id, { sendGate: new VoiceGate(MP), hearGate: new VoiceGate(MP), sending: false, audio: null }).get(id);
  let mic = null, micLevel = null;

  transport.onStream(function onStream(id, stream) {
    const p = presence.peers.get(id); if (!p) return;
    // the stream can arrive a moment before its audio track does
    if (!stream.getAudioTracks().length) { stream.addEventListener('addtrack', () => onStream(id, stream), { once: true }); return; }
    const s = st(id); stopHearing(s);
    // Chrome only delivers WebRTC audio to Web Audio when the stream also feeds a media element
    const el = new Audio(); el.srcObject = stream; el.muted = true; el.play().catch(() => {});
    const pa = new THREE.PositionalAudio(listener);
    pa.setMediaStreamSource(stream);
    pa.panner.panningModel = 'HRTF';
    pa.setDistanceModel('linear'); pa.setRefDistance(MP.voiceFull); pa.setMaxDistance(MP.voiceSilent); pa.setRolloffFactor(1);
    pa.position.y = 1.6;
    s.audio = { el, pa, level: levelMeter(ctx, stream), stream };
    s.hearGate.on = true;
  });
  presence.onLeave(p => { const s = state.get(p.id); if (s) { stopHearing(s); state.delete(p.id); } });

  function stopHearing(s) { if (!s.audio) return; s.audio.pa.disconnect(); s.audio.pa.removeFromParent(); s.audio.el.srcObject = null; s.audio = null; }

  async function setMic(on) {
    if (on && !mic) {
      unlock();
      mic = params.get('fakemic') ? fakeMic(ctx) : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      micLevel = levelMeter(ctx, mic);
    } else if (!on && mic) {
      for (const [id, s] of state) if (s.sending) { transport.stop(presence.peers.get(id) || { id }, mic); s.sending = false; }
      mic.getTracks().forEach(t => t.stop()); mic = null; micLevel = null;
    }
    return !!mic;
  }

  function update(dt) {
    for (const p of presence.peers.values()) {
      const s = st(p.id);
      const send = s.sendGate.update(p.dist, dt);
      if (send && mic && !s.sending) s.sending = transport.send(p, mic);
      if ((!send || !mic) && s.sending) { transport.stop(p, mic); s.sending = false; }
      if (s.audio) {
        if (!s.hearGate.update(p.dist, dt)) { stopHearing(s); continue; }
        if (p.player && s.audio.pa.parent !== p.player.group) p.player.group.add(s.audio.pa);
        if (p.player) p.player.speaking = s.audio.level();
      } else if (p.player) p.player.speaking = 0;
    }
  }

  return { _state: state, update, setMic, get micOn() { return !!mic; }, micLevel: () => micLevel ? micLevel() : 0, listener,
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
