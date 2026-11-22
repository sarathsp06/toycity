// node --test *.test.mjs   (from tools/mcp): the conversation turn policy against a fake call and fake engines
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurns, sentences, notMine, wordsOf, interrupts, quietWindow, joinAudio, cleanHeard, QUIET, MEMORY } from './turn.mjs';
import { fakeTTS, fakeSTT, wavSeconds } from './speech.mjs';

// a WAV whose data chunk is text: what fakeSTT "hears" in it
const wavOf = (s, seconds = 1) => {
  const data = Buffer.from(s), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return { seconds, silent: !s, wav: Buffer.concat([h, data]).toString('base64') };
};

// A call on a virtual clock (ms). The person says `lines` ({ from, to, text }): loud while they speak,
// and each word is heard at its share of the line's time. The agent's clips play for the fake TTS's
// seconds; half a second of the person talking over one stops it (after a 1 s grace at a turn's start),
// as the game's barge-in does.
function fakeCall(lines = [], { members = 1 } = {}) {
  let t = 0, lastTake = 0, lastLoud = -1e9, heardSince = 0, noBarge = false, lastEnd = -1e9;
  const log = [];
  const loud = at => lines.some(l => at >= l.from && at < l.to);
  const tick = () => { t += 10; if (loud(t)) { lastLoud = t; if (!heardSince) heardSince = t; } };
  const heardIn = (a, b) => lines.flatMap(l => { const ws = l.text.split(' '); return [ws.filter((_, i) => { const at = l.from + (i + 0.5) * (l.to - l.from) / ws.length; return at > a && at <= b; }).join(' ')]; }).filter(Boolean);
  const take = () => { const segs = heardIn(lastTake, t), a = wavOf(segs.map(x => x + '|').join(''), (t - lastTake) / 1000); lastTake = t; heardSince = 0; return a; };
  const until = (fn, max) => { const t0 = t; while (!fn() && t - t0 < max) tick(); return fn(); };
  return {
    clock: { now: () => t }, log, get t() { return t; },
    bridge: {
      async begin() { log.push(['begin', t]); return { members, audio: take(), hint: 'Tester' }; },
      async say(wav, offset) {
        if (!members) return { ended: true };
        const { text } = JSON.parse(Buffer.from(wav, 'base64').toString()), seconds = text.split(/\s+/).length * 0.3;   // as fakeTTS says
        log.push(['say', t, text, offset]);
        const grace = t - lastEnd > 1500 ? t + 1000 : offset ? t + 400 : t;
        let played = offset, run = 0;
        while (played < seconds) {
          tick(); played += 0.01; run = loud(t) ? run + 10 : 0;
          if (!noBarge && run >= 500 && t > grace) { lastEnd = t; return { seconds, played, interrupted: true }; }
        }
        lastEnd = t; return { seconds, played: seconds, interrupted: false };
      },
      async take() { return take(); },
      async heardQuiet(ms, max) { return until(() => heardSince > 0 && t - lastLoud >= ms, max); },
      async holdQuiet(ms, max) { const t0 = t; for (;;) { if (heardSince > 0) return 'more'; if (t - lastLoud >= ms || t - t0 >= max) return 'done'; tick(); } },
      async wait(ms) { until(() => false, ms); },
      async noBarge(on) { noBarge = on; log.push(['noBarge', on]); },
    },
  };
}
const turns = (call, tts = fakeTTS()) => createTurns({ bridge: call.bridge, tts, stt: fakeSTT(), clock: call.clock });

test('sentences: split after . ! ? but keep 2.5 km and Dr. Smit, join short bits', () => {
  assert.deepEqual(sentences('It is 2.5 km away. Dr. Smit lives there! Is it? Yes.'), ['It is 2.5 km away.', 'Dr. Smit lives there!', 'Is it? Yes.']);
  assert.ok(sentences('a, '.repeat(150)).every(s => s.length < 220), 'a long sentence is cut at its commas');
});

test('echo: my own words coming back are dropped, an answer that reuses a few stays', () => {
  const mine = [{ w: wordsOf('The canals were dug in the 1600s to move goods by boat.'), at: 0 }];
  assert.equal(notMine('canals were dug in the 1600s to move goods', mine), false);
  assert.equal(notMine('Stop, the canals were dug', mine), true, 'a stop cue is never echo');
  assert.equal(notMine('Oh nice, by boat? I love that', mine), true);
  assert.ok(interrupts('Stop.') && interrupts('tell me more') && !interrupts('yes'));
  assert.deepEqual(cleanHeard([' (laughing) ', '[MUSIC]', 'Thank you.', ' Hello there. ']), ['Hello there.']);
});

test('quiet window: a question ends the turn at once, a hanging sentence waits longer', () => {
  assert.equal(quietWindow('How are you?'), QUIET.question);
  assert.equal(quietWindow('I live here.'), QUIET.statement);
  assert.equal(quietWindow('I was thinking about the'), QUIET.unfinished);
  assert.equal(quietWindow('I went there and'), QUIET.unfinished);
  assert.equal(quietWindow('Well,'), QUIET.unfinished);
  assert.equal(quietWindow(''), null);
  assert.ok(QUIET.statement <= 800 && QUIET.question >= QUIET.first);
});

test('joinAudio: two takes become one WAV with both data chunks', () => {
  const j = joinAudio(wavOf('ab', 1), wavOf('cd', 2)), b = Buffer.from(j.wav, 'base64');
  assert.equal(b.subarray(44).toString(), 'abcd'); assert.equal(b.readUInt32LE(40), 4); assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(j.seconds, 3); assert.equal(wavSeconds(b), 4 / 32000);
});

test('listen: returns right after a question, not a long quiet later', async () => {
  const call = fakeCall([{ from: 1000, to: 3000, text: 'Hello, how are you doing today?' }]);
  const { words } = await turns(call).hear({ seconds: 20 });
  assert.equal(words, 'Hello, how are you doing today?');
  assert.ok(call.t <= 3000 + QUIET.first + 50, `returned ${call.t - 3000} ms after they stopped`);
});

test('listen: a finished sentence ends the turn after the statement window', async () => {
  const call = fakeCall([{ from: 500, to: 2000, text: 'I live on this street.' }]);
  assert.equal((await turns(call).hear({ seconds: 20 })).words, 'I live on this street.');
  assert.ok(call.t >= 2000 + QUIET.statement - 20 && call.t <= 2000 + QUIET.statement + 50, `returned ${call.t - 2000} ms after`);
});

test('listen: a pause mid-sentence does not cut them off; all of it is heard together', async () => {
  const call = fakeCall([{ from: 1000, to: 2500, text: 'I was thinking about the' }, { from: 3300, to: 4500, text: 'canals and the boats.' }]);
  const { words } = await turns(call).hear({ seconds: 20 });
  assert.equal(words, 'I was thinking about the canals and the boats.');
});

test('listen: nothing said -> empty after the time is up', async () => {
  const call = fakeCall([]);
  assert.equal((await turns(call).hear({ seconds: 3 })).words, '');
  assert.ok(call.t >= 3000);
});

test('say: the first sentence is being made before the page is asked anything', async () => {
  const call = fakeCall([]), tts = fakeTTS(), order = [];
  const b = call.bridge.begin; call.bridge.begin = async () => { order.push(['begin', tts.calls.length]); return b(); };
  await turns(call, tts).say('One two three. Four five six. Seven eight nine. Ten eleven twelve.', { thenListen: false });
  assert.ok(order[0][1] >= 1, 'speak(sentence 1) started before begin()');
  assert.deepEqual(tts.calls, ['One two three.', 'Four five six.', 'Seven eight nine.', 'Ten eleven twelve.']);
});

test('say: not in a call', async () => {
  const call = fakeCall([], { members: 0 });
  assert.match(await turns(call).say('Hi there.'), /^You are not in a call/);
});

test('say then listen: their reply comes back', async () => {
  // sentence 1 plays ~0-1.5 s; they answer at 3 s
  const call = fakeCall([{ from: 3000, to: 4200, text: 'Yes, that sounds nice.' }]);
  const out = await turns(call).say('Shall we walk to the canal now?', { listenSeconds: 10 });
  assert.match(out, /^Said it \(\d\.\d s\)\. They replied: "Yes, that sounds nice\."$/);
});

test('say: talked over with words -> stops mid-sentence and returns what they said', async () => {
  // sentence 1: 1.5 s; sentence 2 starts ~1.5 s; they interrupt at 2.5 s
  const call = fakeCall([{ from: 2500, to: 4000, text: 'Stop, stop, tell me about the canals.' }]);
  const out = await turns(call).say('Let me tell you about the map. It is made from open data of the Dutch government. Every building has its real height.', { thenListen: false });
  assert.match(out, /They interrupted you after: "Let me tell you about the map\." \(stopped mid-sentence: "It is made from open data of the Dutch government\."\)\. They said: "Stop, stop, tell me about the canals\."/);
});

test('say: a word or a noise only pauses it; it carries on from just before where it stopped', async () => {
  const call = fakeCall([{ from: 2000, to: 2600, text: 'yes' }]);
  const out = await turns(call).say('One two three four five six seven eight nine ten eleven twelve.', { thenListen: false });
  assert.match(out, /^Said it .*1 time\(s\) a sound made you pause: "yes"; you carried on/);
  const says = call.log.filter(l => l[0] === 'say');
  assert.equal(says.length, 2); assert.ok(says[1][3] > 0.5, 'resumed at an offset');
});

test('say: my own voice coming back (the sentence being spoken) is echo, not an interruption', async () => {
  const call = fakeCall([{ from: 1500, to: 2400, text: 'canals were dug to move goods by boat' }]);
  const out = await turns(call).say('The canals were dug in the 1600s to move goods by boat across the city.', { thenListen: false });
  assert.match(out, /^Said it/); assert.match(out, /a sound made you pause: "a noise"/);
});

test('say: after three false alarms it stops pausing for the noisy room', async () => {
  const call = fakeCall([2000, 3500, 5000].map(f => ({ from: f, to: f + 600, text: 'um' })));
  const out = await turns(call).say('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.', { thenListen: false });
  assert.match(out, /3 time\(s\)/);
  assert.deepEqual(call.log.filter(l => l[0] === 'noBarge'), [['noBarge', true], ['noBarge', false]]);
});

test('spoken memory: what I said more than half a minute ago is no longer echo', async () => {
  const call = fakeCall([]), t = turns(call);
  await t.say('The canals were dug to move goods by boat.', { thenListen: false });
  assert.equal(t.spoken.length, 1);
  await call.bridge.wait(MEMORY + 1000);
  assert.equal(t.spoken.length, 0);
});

test('the call ends between sentences', async () => {
  const call = fakeCall([]); let n = 0;
  const say = call.bridge.say; call.bridge.say = async (w, o) => (++n > 1 ? { ended: true } : say(w, o));
  assert.equal(await turns(call).say('First one here. Second one here.', { thenListen: false }), 'The call ended after: "First one here.".');
});
