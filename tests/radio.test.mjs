// node --test tests/*.test.mjs   (car radio: state machine with a fake <audio>; the real stream is checked in Chromium)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRadio, STATIONS } from '../web/radio.js';

class FakeAudio extends EventTarget {
  constructor() { super(); this.attrs = {}; this.paused = true; this.volume = 1; this.error = null; FakeAudio.last = this; }
  getAttribute(k) { return this.attrs[k] ?? null; } setAttribute(k, v) { this.attrs[k] = v; } removeAttribute(k) { delete this.attrs[k]; }
  load() {} pause() { this.paused = true; }
  play() { this.paused = false; if (FakeAudio.broken.has(this.attrs.src)) { this.error = { code: 4 }; queueMicrotask(() => this.dispatchEvent(new Event('error'))); } else queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve(); }
}
FakeAudio.broken = new Set();
globalThis.performance ||= { now: () => Date.now() };
const store = {}; globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const tick = () => new Promise(r => setTimeout(r, 5));

test('off by default, plays only in a car, remembers the station', async () => {
  const r = createRadio({ Audio: FakeAudio, fade: 0.01 });
  assert.equal(r.on, false); assert.equal(r.station, null); assert.equal(r.label, '📻 off');
  r.toggle(); assert.equal(r.on, true); assert.equal(r.station.name, 'NPO Radio 2');
  assert.ok(!FakeAudio.last || FakeAudio.last.paused, 'not in a car: silent');
  r.update(true); await tick();
  assert.equal(FakeAudio.last.paused, false); assert.equal(FakeAudio.last.attrs.src, STATIONS[0].url);
  r.next(); assert.equal(r.station.name, 'NPO 3FM');
  assert.deepEqual(JSON.parse(store['toycity.radio']), { station: 'NPO 3FM', on: true });
  const r2 = createRadio({ Audio: FakeAudio }); assert.equal(r2.station.name, 'NPO 3FM', 'a reload keeps the station');
  r.dispose(); r2.dispose();
});

test('a dead stream shows no signal and skips to the next; all dead switches off, no loop', async () => {
  delete store['toycity.radio'];
  FakeAudio.broken = new Set([STATIONS[0].url]);
  const r = createRadio({ Audio: FakeAudio, fade: 0.01 });
  r.update(true); r.toggle(); await tick(); await tick();
  assert.equal(r.station.name, 'NPO 3FM', 'skipped the dead one');
  assert.equal(r.signal, true, 'the next one plays');
  FakeAudio.broken = new Set(STATIONS.filter(s => s.url).map(s => s.url));
  r.prev(); for (let i = 0; i < 10; i++) await tick();
  assert.equal(r.on, false, 'everything dead: off, and it stopped trying');
  r.dispose(); FakeAudio.broken = new Set();
});
