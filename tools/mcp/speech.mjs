// Speech ports for a Toy City agent: text to speech (TTS) and speech to text (STT), each one small
// interface with interchangeable adapters, so the conversation policy (turn.mjs) never knows which
// engine runs, and tests can plug in fakes.
//
//   TTS: speak(text, voice) -> { wavB64, seconds }        (throws when it can't)
//        adapters: kokoroTTS (a resident Python worker), systemTTS (macOS say, espeak), fakeTTS
//   STT: transcribe(wavB64, hint) -> string[] | null      (the phrases heard; null: no STT here)
//        adapters: whisperServerSTT (resident whisper-server, model kept loaded), whisperCliSTT (one
//        process per call: loads the model each time, ~5 s slower), fakeSTT
//
// Workers are supervised: a crash or a hang (no answer within the timeout) kills the process, and the
// next request starts it again after a backoff that doubles up to a minute, so a broken install doesn't
// respawn in a loop and a one-off crash doesn't disable the voice for good.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const tmp = tag => path.join(os.tmpdir(), `toycity-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
const backoff = n => Math.min(60000, 1000 * 2 ** Math.max(0, n - 1));
import { note } from './diary.mjs';
const log = (...a) => { if (process.env.TOYCITY_DEBUG) console.error('[speech]', ...a); };   // stderr: stdout is the MCP channel

// seconds of sound in a WAV (PCM): its data chunk over the byte rate
export function wavSeconds(buf) {
  try {
    const rate = buf.readUInt32LE(28);
    for (let o = 12; o + 8 <= buf.length;) {
      const id = buf.toString('ascii', o, o + 4), n = buf.readUInt32LE(o + 4);
      if (id === 'data') return Math.min(n, buf.length - o - 8) / rate;
      o += 8 + n + (n & 1);
    }
  } catch { /* not a WAV */ }
  return 0;
}

// ---------- TTS ----------
export function kokoroPaths() {
  const h = path.join(os.homedir(), '.cache/hyperframes');
  const py = process.env.TOYCITY_KOKORO_PYTHON || path.join(h, 'kokoro-venv/bin/python');
  const model = process.env.TOYCITY_KOKORO_MODEL || path.join(h, 'tts/models/kokoro-v1.0.onnx');
  const voices = process.env.TOYCITY_KOKORO_VOICES || path.join(h, 'tts/voices/voices-v1.0.bin');
  return [py, model, voices].every(f => fs.existsSync(f)) ? { py, model, voices } : null;
}

// Kokoro (a natural neural voice, offline) in one resident worker: the model loads once. Requests carry
// ids, so a reply that comes late (after its timeout) is dropped instead of answering the next one.
export function kokoroTTS({ paths = kokoroPaths(), timeoutMs = 15000, readyMs = 60000 } = {}) {
  let proc = null, ready = null, voices = [], seq = 0, fails = 0, retryAt = 0;
  const pending = new Map();   // id -> { done, timer }
  function start() {
    if (proc) return true;
    if (!paths || Date.now() < retryAt) return false;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'toycity-kokoro-'));   // a clean folder: no stray modules
    const p = proc = spawn(paths.py, ['-I', fileURLToPath(new URL('./kokoro-worker.py', import.meta.url)), paths.model, paths.voices], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });   // stderr: the client's log, never stdout
    let buf = '', setReady;
    ready = new Promise(r => setReady = r);
    p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { voices = m.voices || []; setReady(true); continue; }
        const w = pending.get(m.id); if (!w) continue;   // a late reply to a request already given up on
        pending.delete(m.id); clearTimeout(w.timer); w.done(m);
      }
    });
    p.stdin.on('error', () => {});   // writing to a worker that just died: its exit handler cleans up
    p.on('error', () => {});
    p.on('exit', code => { log('kokoro exited', code); dead(p, 'worker exited'); });
    p.setReady = setReady;
    return true;
  }
  // a worker that crashed or hung: gone at once (the next request starts another, after the backoff)
  function dead(p, why) {
    if (proc !== p) return;
    proc = null; fails++; retryAt = Date.now() + backoff(fails); p.setReady?.(false);
    for (const [id, w] of pending) { clearTimeout(w.timer); w.done({ id, ok: false, error: why }); }
    pending.clear();
    try { p.kill('SIGKILL'); } catch {}
  }
  return {
    name: 'kokoro',
    available: () => !!paths,
    warm() { start(); },
    get voices() { return voices; },
    async speak(text, voice) {
      if (!start()) throw new Error('Kokoro is not available');
      const p = proc;
      let t; const ok = await Promise.race([ready, new Promise(r => t = setTimeout(r, readyMs, false))]); clearTimeout(t);
      if (!ok) { dead(p, 'did not start'); throw new Error('Kokoro did not start'); }
      const id = ++seq;
      const m = await new Promise(done => {
        // a hung worker (no answer in time) is killed; the next request starts a fresh one
        const timer = setTimeout(() => { pending.delete(id); done({ id, ok: false, error: 'timeout' }); dead(p, 'worker hung'); }, timeoutMs);
        pending.set(id, { done, timer });
        p.stdin.write(JSON.stringify({ id, text, voice: voices.includes(voice) ? voice : 'af_heart', speed: 1.0 }) + '\n');
      });
      if (!m.ok || !m.wav) throw new Error('Kokoro: ' + (m.error || 'no sound'));
      fails = 0;
      return { wavB64: m.wav, seconds: m.seconds };
    },
    close() {   // (proc cleared first: its exit is not a crash)
      const p = proc; proc = null; fails = 0; retryAt = 0; try { p?.kill(); } catch {}
      for (const [id, w] of pending) { clearTimeout(w.timer); w.done({ id, ok: false, error: 'closed' }); }
      pending.clear();
    },
  };
}

// the computer's own voice: macOS say, or espeak-ng / espeak
export function systemTTS() {
  return {
    name: 'system',
    async speak(text) {
      const f = tmp('say');
      try {
        if (process.platform === 'darwin') {
          // the system voice first; some voices (Siri ones) write an empty file, so then a classic voice
          for (const v of [[], ['-v', 'Samantha'], ['-v', 'Daniel']]) {
            try { await run('say', [...v, '-o', f, '--data-format=LEI16@22050', text], { timeout: 30000 }); } catch { continue; }
            if (fs.existsSync(f) && fs.statSync(f).size > 2000) break;
          }
        } else {
          let ok = false;
          for (const c of ['espeak-ng', 'espeak']) { try { await run(c, ['-w', f, text], { timeout: 30000 }); ok = true; break; } catch { /* next */ } }
          if (!ok) throw new Error('no text-to-speech here: install espeak-ng, or pass your own audio');
        }
        if (!fs.existsSync(f) || fs.statSync(f).size <= 2000) throw new Error('Text-to-speech produced no sound on this computer.');
        const b = fs.readFileSync(f); return { wavB64: b.toString('base64'), seconds: wavSeconds(b) };
      } finally { fs.rmSync(f, { force: true }); }
    },
    close() {},
  };
}

// the first adapter that works, per request: Kokoro, else the system voice
export function chainTTS(...adapters) {
  return {
    name: adapters.map(a => a.name).join('>'),
    voices: () => adapters.flatMap(a => a.voices || []),
    warm() { adapters.forEach(a => a.warm?.()); },
    async speak(text, voice) {
      let err;
      for (const a of adapters) { try { return await a.speak(text, voice); } catch (e) { err = e; log(a.name, 'failed:', e.message); note('engine', `TTS ${a.name} failed: ${e.message}`); } }
      throw err || new Error('no text-to-speech');
    },
    close() { adapters.forEach(a => a.close?.()); },
  };
}

// tests: speak returns what fn returns (default: the text itself as the "audio", 0.3 s a word)
export function fakeTTS(fn = (text, voice) => ({ wavB64: Buffer.from(JSON.stringify({ text, voice })).toString('base64'), seconds: text.split(/\s+/).length * 0.3 })) {
  const calls = [];
  return { name: 'fake', calls, async speak(text, voice) { calls.push(text); return fn(text, voice); }, close() {} };
}

// ---------- STT ----------
// whisper.cpp with a ggml model, from TOYCITY_WHISPER_MODEL or a usual place. Not found is checked again
// after a minute (someone may be installing it right now); found is kept.
let found, foundAt = 0;
export function findWhisper() {
  if (found || (found === null && Date.now() - foundAt < 60000)) return found;
  foundAt = Date.now();
  const home = os.homedir(), cands = [process.env.TOYCITY_WHISPER_MODEL, ...['.cache/whisper', '.cache/hyperframes/whisper/models', '.whisper', 'Library/Application Support/whisper']
    .flatMap(d => { try { return fs.readdirSync(path.join(home, d)).filter(f => /^ggml-.*\.bin$/.test(f) && !/silero/.test(f)).map(f => path.join(home, d, f)); } catch { return []; } }),
    '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin', '/usr/local/share/whisper-cpp/ggml-base.en.bin'].filter(Boolean);
  const model = cands.find(f => fs.existsSync(f));
  const which = b => { try { return execFileSync('which', [b], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
  const bin = ['whisper-cli', 'whisper-cpp', 'main'].map(which).find(Boolean);
  const server = process.env.TOYCITY_WHISPER_SERVER === '0' ? null : which('whisper-server');
  return (found = model && (bin || server) ? { bin, server, model } : null);
}

// Voice activity detection (Silero, a 1 MB model whisper.cpp loads): only the stretches with speech are
// transcribed, so noise and silence don't come out as made-up words. Fetched once into ~/.cache/toycity,
// with a timeout: a stalled download must not hold up the voice.
export const VAD = process.env.TOYCITY_VAD_MODEL || path.join(os.homedir(), '.cache/toycity/ggml-silero-v5.1.2.bin');
export async function fetchVad(timeoutMs = 20000) {
  if (fs.existsSync(VAD)) return true;
  try {
    const r = await fetch('https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const body = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(VAD), { recursive: true });
    const part = `${VAD}.${process.pid}.part`;   // our own name: two agents may fetch it at once
    fs.writeFileSync(part, body); fs.renameSync(part, VAD);
    return true;
  } catch { return false; }   // offline: transcribe without it
}
const PROMPT = 'A voice call in Toy City, a game set in Dutch towns.';

// whisper-cli, one process per call (the model is loaded every time)
export function whisperCliSTT({ bin, model, timeoutMs = 90000 }) {
  return {
    name: 'whisper-cli',
    async transcribe(wavB64, hint = '') {
      const f = tmp('heard');
      fs.writeFileSync(f, Buffer.from(wavB64, 'base64'));
      const args = ['-m', model, '-f', f, '-nt', '-np', '-l', 'en', '-sns', '--prompt', `${PROMPT}${hint ? ' ' + hint : ''}`];
      if (fs.existsSync(VAD)) args.push('--vad', '-vm', VAD);
      try { const { stdout } = await run(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20 }); return stdout.split('\n'); }
      finally { fs.rmSync(f, { force: true }); }
    },
    close() {},
  };
}

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// whisper-server, started once and kept: the model stays loaded, so a phrase is words in well under
// a second instead of ~6 s. HTTP /inference on a private port; restarted (with backoff) when it exits or
// stops answering.
export function whisperServerSTT({ server, model, timeoutMs = 20000, startMs = 60000 }) {
  let proc = null, up = null, url = null, fails = 0, retryAt = 0;
  function start() {
    if (proc) return up;
    if (Date.now() < retryAt) return null;
    const p = proc = { child: null };
    up = (async () => {
      const port = await freePort();
      const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-nt', '-sns', '-l', 'en'];
      if (fs.existsSync(VAD)) args.push('--vad', '-vm', VAD);
      const child = p.child = spawn(server, args, { stdio: 'ignore' });
      child.on('error', () => {});
      child.on('exit', code => {
        if (proc !== p) return;
        proc = null; fails++; retryAt = Date.now() + backoff(fails); log('whisper-server exited', code);
      });
      const u = `http://127.0.0.1:${port}`;
      for (const t0 = Date.now(); Date.now() - t0 < startMs;) {
        if (proc !== p) return false;
        try { await fetch(u + '/', { signal: AbortSignal.timeout(1000) }); url = u; return true; } catch { await new Promise(r => setTimeout(r, 150)); }
      }
      stop(p); return false;
    })();
    return up;
  }
  function stop(p = proc) { if (!p) return; if (proc === p) { proc = null; fails++; retryAt = Date.now() + backoff(fails); } try { p.child?.kill('SIGKILL'); } catch {} }
  return {
    name: 'whisper-server',
    warm() { start(); },
    async transcribe(wavB64, hint = '') {
      const s = start(); if (!s || !await s) throw new Error('whisper-server is not running');
      const p = proc, form = new FormData();
      form.append('file', new Blob([Buffer.from(wavB64, 'base64')], { type: 'audio/wav' }), 'heard.wav');
      form.append('response_format', 'verbose_json');
      form.append('prompt', `${PROMPT}${hint ? ' ' + hint : ''}`);
      try {
        const r = await fetch(url + '/inference', { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) throw new Error('whisper-server: HTTP ' + r.status);
        const j = await r.json(); fails = 0;
        return Array.isArray(j.segments) ? j.segments.map(s => s.text || '') : String(j.text || '').split('\n');
      } catch (e) { if (e.name === 'TimeoutError') stop(p); throw e; }   // hung: start afresh next time
    },
    close() { const p = proc; proc = null; fails = 0; retryAt = 0; try { p?.child?.kill(); } catch {} },
  };
}

// what this computer has: the resident server when installed, else (or when it fails) whisper-cli
export function whisperSTT() {
  let srv = null, cli = null, key = '';
  const pick = () => {
    const w = findWhisper(); if (!w) return null;
    if (key !== w.model) { srv?.close(); key = w.model; srv = w.server ? whisperServerSTT(w) : null; cli = w.bin ? whisperCliSTT(w) : null; }
    return { srv, cli };
  };
  return {
    name: 'whisper',
    available() { return !!pick(); },
    warm() { pick()?.srv?.warm(); },
    async transcribe(wavB64, hint) {
      const a = pick(); if (!a) return null;
      if (a.srv) { try { return await a.srv.transcribe(wavB64, hint); } catch (e) { log('server failed:', e.message); note('engine', `whisper-server failed: ${e.message}`); } }
      if (a.cli) { try { return await a.cli.transcribe(wavB64, hint); } catch (e) { log('cli failed:', e.message); note('engine', `whisper-cli failed: ${e.message}`); } }
      return null;
    },
    close() { srv?.close(); srv = null; key = ''; },
  };
}

// tests: fn(wavB64, hint) -> phrases (default: the WAV's data chunk as text, phrases split by '|')
export function fakeSTT(fn = wavB64 => { const b = Buffer.from(wavB64, 'base64'); return b.subarray(44).toString('utf8').split('|').filter(Boolean); }) {
  const calls = [];
  return { name: 'fake', calls, async transcribe(w, hint) { calls.push(hint); return fn(w, hint); }, close() {} };
}

// the adapters this computer has
export function defaultSpeech() {
  const k = kokoroPaths();
  return { tts: k ? chainTTS(kokoroTTS({ paths: k }), systemTTS()) : systemTTS(), stt: whisperSTT() };
}
