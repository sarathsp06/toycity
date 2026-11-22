// node --test *.test.mjs   (from tools/mcp): the speech adapters' supervision, against a fake Kokoro worker
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kokoroTTS, chainTTS, fakeTTS, findWhisper } from './speech.mjs';

// a stand-in for "python kokoro-worker.py": same protocol; "hang" never answers, "crash" exits, "late"
// answers after 300 ms; a request's reply carries its id
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toycity-speech-test-'));
fs.writeFileSync(path.join(dir, 'worker.mjs'), `
import readline from 'node:readline';
console.log(JSON.stringify({ ready: true, voices: ['af_heart', 'am_michael'] }));
const wav = Buffer.alloc(44 + 3200).toString('base64');
readline.createInterface({ input: process.stdin }).on('line', l => {
  const r = JSON.parse(l), reply = () => console.log(JSON.stringify({ id: r.id, ok: true, seconds: 0.1, wav, said: r.text, voice: r.voice }));
  if (r.text === 'hang') return; if (r.text === 'crash') process.exit(1);
  if (r.text === 'late') return setTimeout(reply, 300); reply();
});`);
fs.writeFileSync(path.join(dir, 'py'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'worker.mjs')}"\n`, { mode: 0o755 });
const paths = { py: path.join(dir, 'py'), model: 'm', voices: 'v' };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('kokoro: answers come back to the request that asked', async () => {
  const k = kokoroTTS({ paths, timeoutMs: 1000 });
  const [a, b] = await Promise.all([k.speak('one', 'am_michael'), k.speak('two', 'nobody')]);
  assert.ok(a.wavB64 && b.wavB64); assert.equal(a.seconds, 0.1);
  assert.deepEqual(k.voices, ['af_heart', 'am_michael']);
  k.close();
});

test('kokoro: a late reply is dropped, not given to the next request; a hang is killed and restarted after a backoff', async () => {
  const k = kokoroTTS({ paths, timeoutMs: 150 });
  await assert.rejects(k.speak('late'), /timeout/);
  await assert.rejects(k.speak('again'), /not available/, 'in the backoff');
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await k.speak('fresh')).seconds, 0.1, 'a new worker after the backoff');
  await assert.rejects(k.speak('crash'), /exited/);
  await new Promise(r => setTimeout(r, 1100));
  assert.ok((await k.speak('back')).wavB64, 'restarted again after a crash, not given up after one');
  k.close();
});

test('chain: falls back to the next engine per request', async () => {
  const bad = { name: 'bad', speak: async () => { throw new Error('no'); } }, good = fakeTTS();
  const c = chainTTS(bad, good);
  assert.ok((await c.speak('hello there')).wavB64); assert.deepEqual(good.calls, ['hello there']);
});

test('whisper: found or not, the answer has the right shape', () => {
  const w = findWhisper();
  assert.ok(w === null || (w.model && (w.bin || w.server)));
});
