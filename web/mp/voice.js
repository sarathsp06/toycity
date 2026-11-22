// Spatial voice: microphone, who I talk to, and where their voices come from.
// Knows peers only through presence (id, distance, avatar), and moves audio through a transport.
//
// Audio moves through a transport (transport.js: send/stop/routed/onStream by player id), which owns
// the routing: voice never looks at connections. Who gets my microphone is inCall(id), decided again
// every frame and, in a hidden tab where frames stop, every presence heartbeat (route()).
//
// The agent audio bridge (?agent=1, ear with &voice=1), window.__agentVoice, driven by tools/mcp/server.mjs:
//   say(b64wav, { offset } | offset) -> Promise<{ seconds, played, interrupted }>
//                     play a clip into the call from offset s; resolves at its end, or early (interrupted)
//                     when the other person talks over it (barge-in, thresholds in BARGE)
//   stop()            end what is playing now (its say resolves interrupted)
//   take(maxSec?)     -> { seconds, silent, wav }: what was heard since the last take (16 kHz mono WAV,
//                     base64; the last maxSec seconds only, when given). Kept only in a call or for 2
//                     minutes after a take, 120 s at most.
//   spoke(quietMs?)   something was heard since the last take and then quiet for quietMs (1100)
//   waitSpeech(timeoutMs?, quietMs?) -> Promise<bool>  resolves when spoke() is true, or false at the timeout
//   quietFor()        ms since the last loud sound (Infinity: none yet)
//   speaking, lastLoud (performance.now() of the last sound above the floor), heardSince (when sound was
//   first heard since the last take, 0: nothing yet), graceUntil, noBarge (set true: no barge-in for now),
//   outLevel() (how loud I am right now)
import * as THREE from 'three';
import { MP } from './config.js';
import { createSender } from './transport.js';
export { p2pTransport } from './transport.js';

// Voice problems are hard to see, so the voice path logs every step: filter the console on [voice].
const log = (...a) => console.log('[voice]', ...a);
const short = id => String(id).slice(0, 6);

export function createVoice({ camera, player, presence, transport, params, inCall = () => true, busy = () => false, onMicLost = () => {} }) {
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
  const agent = params.get('agent') === '1' ? agentVoice(ctx, params.get('voice') === '1' ? listener.getInput() : null, busy) : null;
  ctx.addEventListener('statechange', () => log('audio context', ctx.state));
  const unlock = () => { if (ctx.state !== 'running') ctx.resume().then(() => log('audio context resumed')).catch(e => log('resume failed', e)); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

  const state = new Map();          // peer id -> { audio }: what I hear of them
  const st = id => state.get(id) || state.set(id, { audio: null }).get(id);
  const sender = createSender(transport, inCall);   // what they hear of me
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
  presence.onLeave(p => { sender.forget(p.id); const s = state.get(p.id); if (s) { stopHearing(s); state.delete(p.id); } });

  function stopHearing(s) { if (!s.audio) return; log('stopped hearing a player'); s.audio.pa.disconnect(); s.audio.pa.removeFromParent(); s.audio.el.srcObject = null; s.audio.level.dispose(); s.audio = null; }

  // one at a time: a call that ends while the microphone permission is still open must not leave
  // the microphone on afterwards
  let micQ = Promise.resolve(), micWant = false;
  const setMic = on => (micQ = micQ.then(() => setMicNow(on), () => setMicNow(on)));
  async function setMicNow(on) {
    micWant = on;
    if (on && !mic) {
      unlock();
      const m = agent ? agent.mouth() : params.get('fakemic') ? fakeMic(ctx) : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!micWant) { m.getTracks().forEach(t => t.stop()); return false; }
      mic = m; micLevel = levelMeter(ctx, mic);
      // unplugged, or the permission taken away: let go of it, so the next setMic(true) opens a new one
      for (const t of m.getAudioTracks()) t.addEventListener('ended', () => { if (mic !== m) return; log('mic track ended (unplugged or permission revoked): mic released'); release(); onMicLost(); });
      log('mic on:', mic.getAudioTracks().map(t => t.label || 'track'), '; audio context', ctx.state);
    } else if (!on && mic) { release(); log('mic off'); }
    return !!mic;
  }
  function release() { sender.stopAll(mic); mic.getTracks().forEach(t => t.stop()); mic = null; if (micLevel) micLevel.dispose(); micLevel = null; }

  // who gets my microphone: from update() every frame, and from the presence heartbeat in a hidden tab
  function route() { for (const p of presence.peers.values()) sender.step(p.id, mic); }

  let logT = 0;
  function update(dt) {
    ears.quaternion.copy(ears.parent.getWorldQuaternion(_p).invert().multiply(camera.getWorldQuaternion(_q)));
    if ((logT -= dt) <= 0) {   // a summary every 5 s while anyone is near
      logT = 5;
      const near = [...presence.peers.values()].filter(p => p.dist < MP.talkReach);
      if (near.length) log('summary: context', ctx.state, '| mic', mic ? 'on, level ' + micLevel().toFixed(3) : 'off',
        '|', near.map(p => { const s = st(p.id); return `${short(p.id)} ${p.dist.toFixed(1)} m: sending ${sender.sending(p.id)}, hearing ${!!s.audio}${s.audio ? ', in ' + s.audio.level().toFixed(3) : ''}`; }).join('; '),
        '| out level', outLevel().toFixed(3));
    }
    for (const p of presence.peers.values()) {
      sender.step(p.id, mic);   // my voice goes only to the people I am in a call with, over a link that is still open
      const s = st(p.id);
      if (s.audio) {
        if (p.player && s.audio.pa.parent !== p.player.group) p.player.group.add(s.audio.pa);
        if (p.player) p.player.speaking = s.audio.level();
      } else if (p.player) p.player.speaking = 0;
    }
  }

  return { update, route, setMic, get micOn() { return !!mic; }, micLevel: () => micLevel ? micLevel() : 0, listener,
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

// ---------- an AI agent's voice (tools/mcp, ?agent=1&voice=1): the bridge, see the top of this file ----------
// Barge-in, in one place. Half a second of clear sound while I speak stops me. That is only a
// suspicion: the server then hears what it was, and carries on where I stopped when it was a noise, or
// my own voice coming back through their speakers (the game plays voices through Web Audio, which the
// browser's echo cancelling does not see).
export const BARGE = Object.freeze({
  floor: 0.02,       // rms above this is "sound" (lastLoud, heardSince)
  voice: 0.035,      // and above this, someone talking over me
  echo: 0.5,         // echo through their speakers comes back well under half my own level; a voice beside it does not
  ownBlocks: 8,      // my own level is the loudest of the last 8 blocks (~0.7 s at 4096 samples)
  hold: 0.5,         // seconds of talking over me that stop me (it decays at half speed)
  grace: 1000,       // ms at the start of a new turn in which I can't be stopped (the one who spoke last keeps the floor)
  graceResume: 400,  // ms, carrying on after a false alarm
  newTurn: 1500,     // ms of my silence after which a say is a new turn
  quiet: 1100,       // ms of quiet that ends their sentence (spoke, waitSpeech)
});
const EAR = { rate: 16000, maxS: 120, keepS: 120, block: 4096, silentPeak: 300 };

function agentVoice(ctx, input, busy) {
  const v = (window.__agentVoice ||= {});
  let mouth = null;
  const an = ctx.createAnalyser(); an.fftSize = 512; const abuf = new Float32Array(an.fftSize);
  v.outLevel = () => { an.getFloatTimeDomainData(abuf); let e = 0; for (const x of abuf) e += x * x; return Math.sqrt(e / abuf.length); };   // how loud I am right now
  v.speaking = false; v.lastLoud = 0; v.heardSince = 0; v.graceUntil = 0; v.noBarge = false; v.stop = () => {};
  v.quietFor = () => v.lastLoud ? performance.now() - v.lastLoud : Infinity;
  v.spoke = (quietMs = BARGE.quiet) => v.heardSince > 0 && performance.now() - v.lastLoud > quietMs;
  v.waitSpeech = (timeoutMs = 20000, quietMs = BARGE.quiet) => new Promise(done => {
    const t0 = performance.now(), iv = setInterval(() => { const ok = v.spoke(quietMs); if (ok || performance.now() - t0 > timeoutMs) { clearInterval(iv); done(ok); } }, 100);
  });
  // plays one clip from offset seconds on; played is how far into the clip it got (so a false alarm can
  // carry on from there)
  v.say = async (b64, opts = 0) => {
    const offset = typeof opts === 'number' ? opts : +(opts?.offset) || 0;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const src = ctx.createBufferSource(); src.buffer = buf; if (mouth) src.connect(mouth); src.connect(an);
    const t0 = ctx.currentTime;
    return new Promise(done => {
      v.stop?.();   // whatever was still playing ends now (its promise resolves as interrupted)
      const finish = interrupted => { if (v.current !== src) return; v.current = null; v.speaking = false; v.lastEnd = performance.now(); v.stop = () => {}; try { src.stop(); } catch {} done({ seconds: buf.duration, played: Math.min(buf.duration, offset + ctx.currentTime - t0), interrupted }); };
      if (performance.now() - (v.lastEnd || 0) > BARGE.newTurn) v.graceUntil = performance.now() + BARGE.grace;
      else if (offset) v.graceUntil = performance.now() + BARGE.graceResume;
      v.current = src; v.speaking = true; v.stop = () => finish(true);
      src.onended = () => finish(false);
      src.start(0, Math.min(Math.max(0, offset), buf.duration));
    });
  };
  if (input) agentEar(ctx, input, v, busy);
  else v.take = () => null;
  // the microphone: a new stream each time (a stopped track cannot be restarted)
  return { mouth() { mouth = ctx.createMediaStreamDestination(); return mouth.stream; } };
}

// the ear: everything I hear (the call, through the listener), 16 kHz mono in a ring of 120 s
function agentEar(ctx, input, v, busy) {
  const RATE = EAR.rate, MAX = RATE * EAR.maxS, ring = new Int16Array(MAX), step = ctx.sampleRate / RATE;
  let w = 0, n = 0, acc = 0, cnt = 0, phase = 0, keepUntil = 0, loud = 0, oi = 0;
  const own = new Float32Array(BARGE.ownBlocks);
  function hear(x) {
    // kept only in a call, or for a while after a take (the agent is listening); averaged over each
    // output sample's span before keeping one in step (a box low-pass: no aliasing of hiss into speech)
    if (busy() || performance.now() < keepUntil) {
      for (let i = 0; i < x.length; i++) {
        acc += x[i]; cnt++;
        if (++phase >= step) { phase -= step; const s = acc / cnt; acc = 0; cnt = 0; ring[w] = Math.max(-1, Math.min(1, s)) * 32767; w = (w + 1) % MAX; if (n < MAX) n++; }
      }
    } else { acc = 0; cnt = 0; phase = 0; }
    let e2 = 0; for (let i = 0; i < x.length; i++) e2 += x[i] * x[i];
    const rms = Math.sqrt(e2 / x.length), dt = x.length / ctx.sampleRate;
    // my own voice, as loud as it has been lately: what comes back from their speakers is quieter than
    // that, so only sound clearly above it counts as someone talking
    own[oi++ % own.length] = v.outLevel(); let ownMax = 0; for (const o of own) if (o > ownMax) ownMax = o;
    const floor = Math.max(BARGE.floor, ownMax * BARGE.echo);
    if (rms > floor) { v.lastLoud = performance.now(); if (!v.heardSince) v.heardSince = v.lastLoud; }
    loud = rms > Math.max(BARGE.voice, floor) ? loud + dt : Math.max(0, loud - dt / 2);
    if (v.speaking && !v.noBarge && loud > BARGE.hold && performance.now() > (v.graceUntil || 0)) { loud = 0; v.stop(); }
  }
  tap(ctx, input, hear);
  v.take = (maxSec) => {
    keepUntil = performance.now() + EAR.keepS * 1000;
    const k = maxSec > 0 ? Math.min(n, Math.round(maxSec * RATE)) : n, pcm = new Int16Array(k), from = (w - k + MAX) % MAX;
    if (from + k <= MAX) pcm.set(ring.subarray(from, from + k)); else { pcm.set(ring.subarray(from)); pcm.set(ring.subarray(0, k - (MAX - from)), MAX - from); }
    n = 0; v.heardSince = 0;
    let peak = 0; for (const x of pcm) peak = Math.max(peak, Math.abs(x));
    const wav = new DataView(new ArrayBuffer(44 + pcm.length * 2)), wr = (o, t) => [...t].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
    wr(0, 'RIFF'); wav.setUint32(4, 36 + pcm.length * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
    wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, RATE, true);
    wav.setUint32(28, RATE * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); wr(36, 'data'); wav.setUint32(40, pcm.length * 2, true);
    const u = new Uint8Array(wav.buffer); u.set(new Uint8Array(pcm.buffer), 44);   // every browser platform is little-endian
    const parts = []; for (let i = 0; i < u.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)));
    return { seconds: pcm.length / RATE, silent: peak < EAR.silentPeak, wav: btoa(parts.join('')) };
  };
}

// blocks of EAR.block samples from an audio node: an AudioWorklet (off the main thread), else the
// older ScriptProcessor. Either outputs silence; it only listens.
const EAR_WORKLET = `registerProcessor('toycity-ear', class extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(${EAR.block}); this.n = 0; }
  process(inputs) { const x = inputs[0] && inputs[0][0]; if (x) for (let i = 0; i < x.length; i++) { this.b[this.n++] = x[i]; if (this.n === this.b.length) { this.port.postMessage(this.b, [this.b.buffer]); this.b = new Float32Array(${EAR.block}); this.n = 0; } } return true; }
});`;
async function tap(ctx, input, hear) {
  try {
    const url = URL.createObjectURL(new Blob([EAR_WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(ctx, 'toycity-ear', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = e => hear(e.data);
    input.connect(node); node.connect(ctx.destination); log('agent ear: AudioWorklet');
    return;
  } catch (e) { log('agent ear: no AudioWorklet (' + (e?.message || e) + '), ScriptProcessor instead'); }
  const sp = ctx.createScriptProcessor(EAR.block, 1, 1);
  input.connect(sp); sp.connect(ctx.destination);
  sp.onaudioprocess = e => hear(e.inputBuffer.getChannelData(0));
}
