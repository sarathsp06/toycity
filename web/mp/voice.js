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

export function createVoice({ camera, player, presence, transport, params, inCall = () => true }) {
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
  if (params.get('agent') === '1' && params.get('voice') === '1') agentEar(ctx, listener.getInput());
  ctx.addEventListener('statechange', () => log('audio context', ctx.state));
  const unlock = () => { if (ctx.state !== 'running') ctx.resume().then(() => log('audio context resumed')).catch(e => log('resume failed', e)); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

  const state = new Map();          // peer id -> { sending, audio }
  const st = id => state.get(id) || state.set(id, { sending: false, audio: null }).get(id);
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
    // a call: everyone in it is heard at full volume wherever they stand, still from their direction
    pa.setDistanceModel('linear'); pa.setRefDistance(1e4); pa.setMaxDistance(1e5); pa.setRolloffFactor(1);
    pa.position.y = 1.6;
    s.audio = { el, pa, level: levelMeter(ctx, stream), stream };
    // keep playing until the sender stops sending; distance only turns the volume down. (Dropping it
    // on my own distance check lost the voice for good when the two sides disagreed by a moment.)
    const ended = () => { if (s.audio?.stream === stream) stopHearing(s); };
    stream.addEventListener('removetrack', ended); track.addEventListener('ended', ended);
    log('hearing', short(id), '; audio context', ctx.state);
  });
  presence.onLeave(p => { const s = state.get(p.id); if (s) { stopHearing(s); state.delete(p.id); } });

  function stopHearing(s) { if (!s.audio) return; log('stopped hearing a player'); s.audio.pa.disconnect(); s.audio.pa.removeFromParent(); s.audio.el.srcObject = null; s.audio.level.dispose(); s.audio = null; }

  // one at a time: a call that ends while the microphone permission is still open must not leave
  // the microphone on afterwards
  let micQ = Promise.resolve(), micWant = false;
  const setMic = on => (micQ = micQ.then(() => setMicNow(on), () => setMicNow(on)));
  async function setMicNow(on) {
    micWant = on;
    if (on && !mic) {
      unlock();
      const m = params.get('agent') === '1' ? agentMouth(ctx) : params.get('fakemic') ? fakeMic(ctx) : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!micWant) { m.getTracks().forEach(t => t.stop()); return false; }
      mic = m; micLevel = levelMeter(ctx, mic);
      log('mic on:', mic.getAudioTracks().map(t => t.label || 'track'), '; audio context', ctx.state);
    } else if (!on && mic) {
      for (const [id, s] of state) if (s.sending) { transport.stop(presence.peers.get(id) || { id }, mic); s.sending = false; }
      mic.getTracks().forEach(t => t.stop()); mic = null; if (micLevel) micLevel.dispose(); micLevel = null; log('mic off');
    }
    return !!mic;
  }

  let logT = 0;
  function update(dt) {
    ears.quaternion.copy(ears.parent.getWorldQuaternion(_p).invert().multiply(camera.getWorldQuaternion(_q)));
    if ((logT -= dt) <= 0) {   // a summary every 5 s while anyone is near
      logT = 5;
      const near = [...presence.peers.values()].filter(p => p.dist < MP.talkReach);
      if (near.length) log('summary: context', ctx.state, '| mic', mic ? 'on, level ' + micLevel().toFixed(3) : 'off',
        '|', near.map(p => { const s = st(p.id); return `${short(p.id)} ${p.dist.toFixed(1)} m: sending ${s.sending}, hearing ${!!s.audio}${s.audio ? ', in ' + s.audio.level().toFixed(3) : ''}`; }).join('; '),
        '| out level', outLevel().toFixed(3));
    }
    for (const p of presence.peers.values()) {
      const s = st(p.id);
      const send = inCall(p.id);   // my voice goes only to the people I am in a call with
      // the square whose connection carried my voice was left (we still share another): send again there
      if (s.sending && mic && p._voiceRoom && !presence.rooms.has(p._voiceRoom.key)) { transport.stop(p, mic); s.sending = false; }
      if (send && mic && !s.sending) s.sending = transport.send(p, mic);
      if ((!send || !mic) && s.sending) { transport.stop(p, mic); s.sending = false; }
      if (s.audio) {
        if (p.player && s.audio.pa.parent !== p.player.group) p.player.group.add(s.audio.pa);
        if (p.player) p.player.speaking = s.audio.level();
      } else if (p.player) p.player.speaking = 0;
    }
  }

  return { update, setMic, get micOn() { return !!mic; }, micLevel: () => micLevel ? micLevel() : 0, listener,
    talking: id => (state.get(id)?.audio?.level() || 0) > 0.02 };
}

// loudness 0..1 of a stream, for the "is talking" ring and my microphone button
function levelMeter(ctx, stream) {
  const a = ctx.createAnalyser(); a.fftSize = 512;
  let src; try { src = ctx.createMediaStreamSource(stream); src.connect(a); } catch { return Object.assign(() => 0, { dispose() {} }); }   // no audio track (yet)
  const buf = new Float32Array(a.fftSize);
  const level = () => { a.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; return Math.sqrt(s / buf.length); };
  level.dispose = () => { src.disconnect(); a.disconnect(); };
  return level;
}

// test aid (?fakemic=1): a soft beeping tone instead of a real microphone
function fakeMic(ctx) {
  const o = ctx.createOscillator(), g = ctx.createGain(), lfo = ctx.createOscillator(), dst = ctx.createMediaStreamDestination();
  o.frequency.value = 440; lfo.frequency.value = 1.5; g.gain.value = 0;
  lfo.connect(g.gain); o.connect(g).connect(dst); o.start(); lfo.start();
  return dst.stream;
}

// ---------- an AI agent's voice (tools/mcp, ?agent=1&voice=1) ----------
// Its mouth is a stream it speaks WAV clips into (window.__agentVoice.say); its ear keeps what it heard
// in the call, 16 kHz mono, until the agent takes it (window.__agentVoice.take, a WAV as base64).
let mouth = null;
function agentMouth(ctx) {
  mouth = ctx.createMediaStreamDestination();   // a new one each time: a stopped track cannot be restarted
  const v = (window.__agentVoice ||= {});
  const an = ctx.createAnalyser(); an.fftSize = 512; const buf = new Float32Array(an.fftSize);
  v.outLevel = () => { an.getFloatTimeDomainData(buf); let e = 0; for (const x of buf) e += x * x; return Math.sqrt(e / buf.length); };   // how loud I am right now
  // plays one clip from offset seconds on; resolves when it has finished, or as soon as the other
  // person seems to talk over it (barge-in, see agentEar): { seconds, played, interrupted }, where played
  // is how far into the clip it got (so a false alarm can carry on from there)
  v.say = async (b64, offset = 0) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(mouth); src.connect(an);
    const t0 = ctx.currentTime;
    return new Promise(done => {
      v.stop?.();   // whatever was still playing ends now (its promise resolves as interrupted)
      const finish = interrupted => { if (v.current !== src) return; v.current = null; v.speaking = false; v.lastEnd = performance.now(); try { src.stop(); } catch {} done({ seconds: buf.duration, played: Math.min(buf.duration, offset + ctx.currentTime - t0), interrupted }); };
      // starting a new turn (not the next sentence of one): a second in which I can't be stopped, so
      // when two cut in on each other, the one who spoke last keeps the floor
      if (performance.now() - (v.lastEnd || 0) > 1500) v.graceUntil = performance.now() + 1000;
      else if (offset) v.graceUntil = performance.now() + 400;   // carrying on after a false alarm: not at once again
      v.current = src; v.speaking = true; v.stop = () => finish(true);
      src.onended = () => finish(false);
      src.start(0, Math.min(Math.max(0, offset), buf.duration));
    });
  };
  return mouth.stream;
}
function agentEar(ctx, input) {
  const RATE = 16000, MAX = RATE * 120, chunks = []; let n = 0;
  const tap = ctx.createScriptProcessor(4096, 1, 1), step = ctx.sampleRate / RATE;
  input.connect(tap); tap.connect(ctx.destination);   // (it outputs silence; it only listens)
  tap.onaudioprocess = e => {
    const x = e.inputBuffer.getChannelData(0), out = new Int16Array(Math.floor(x.length / step));
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, x[Math.floor(i * step)])) * 32767;
    chunks.push(out); n += out.length;
    while (n > MAX) n -= chunks.shift().length;   // the last two minutes at most
    // barge-in: half a second of clear sound while I speak stops me. That is only a suspicion: the
    // server then hears what it was, and carries on where I stopped when it was a noise, or my own
    // voice coming back through their speakers (the game plays voices through Web Audio, which the
    // browser's echo cancelling does not see). v.noBarge turns it off for the rest of a say.
    let e2 = 0; for (let i = 0; i < x.length; i++) e2 += x[i] * x[i];
    const rms = Math.sqrt(e2 / x.length), dt = x.length / ctx.sampleRate;
    // my own voice, as loud as it has been in the last ~0.7 s: what comes back from their speakers is
    // quieter than that, so only sound clearly above it counts as someone talking
    own[oi++ % own.length] = v.outLevel ? v.outLevel() : 0; let ownMax = 0; for (const o of own) if (o > ownMax) ownMax = o;
    const floor = Math.max(0.02, ownMax * 0.5);   // (echo through their speakers comes back well under half my level; a voice beside it does not)
    if (rms > floor) { v.lastLoud = performance.now(); if (!v.heardSince) v.heardSince = v.lastLoud; }
    loud = rms > Math.max(0.035, floor) ? loud + dt : Math.max(0, loud - dt / 2);
    if (v.speaking && !v.noBarge && loud > 0.5 && performance.now() > (v.graceUntil || 0)) { loud = 0; v.stop?.(); }
  };
  let loud = 0; const own = new Float32Array(8); let oi = 0;
  const v = (window.__agentVoice ||= {});
  v.lastLoud = 0; v.heardSince = 0;   // heardSince: when sound was first heard since the last take (0: nothing yet)
  v.take = () => {
    const pcm = new Int16Array(n); let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
    chunks.length = 0; n = 0; v.heardSince = 0;
    let peak = 0; for (const x of pcm) peak = Math.max(peak, Math.abs(x));
    const wav = new DataView(new ArrayBuffer(44 + pcm.length * 2)), w = (o, t) => [...t].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); wav.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, RATE, true);
    wav.setUint32(28, RATE * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); w(36, 'data'); wav.setUint32(40, pcm.length * 2, true);
    const u = new Uint8Array(wav.buffer); u.set(new Uint8Array(pcm.buffer), 44);   // every browser platform is little-endian
    const parts = []; for (let i = 0; i < u.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)));
    return { seconds: pcm.length / RATE, silent: peak < 300, wav: btoa(parts.join('')) };
  };
}
