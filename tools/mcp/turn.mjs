// A conversation turn for a Toy City agent: speak sentence by sentence, stop when talked over (and
// carry on when it was only a noise or my own voice coming back), and hear the reply as soon as the
// other person has finished. Policy only: everything it touches comes in through ports, so it runs
// against the real page and engines (server.mjs) or against fakes (turn.test.mjs).
//
//   bridge  the call in the page (see pageBridge in session.mjs):
//           begin() -> { members, audio, hint }   in a call?, what was heard so far, names nearby; one round trip
//           say(wavB64, offset) -> { seconds, played, interrupted } | { ended }   plays one clip (if still in a call)
//           heardQuiet(ms, maxMs) -> bool          sound since the last take, then quiet for ms
//           holdQuiet(ms, maxMs) -> 'done'|'more'   quiet for ms since the last sound, or new sound came
//           take() -> audio | null                 everything heard since the last take ({ seconds, silent, wav })
//           wait(ms), noBarge(on)
//   tts     speak(text, voice) -> { wavB64, seconds }        (speech.mjs)
//   stt     transcribe(wavB64, hint) -> string[] | null      (speech.mjs)
//   clock   now() -> ms
import { wavSeconds } from './speech.mjs';

// how long a quiet must last before their turn is over (ms). A first short quiet starts the words being
// made out; what they said then decides how long to wait: a question is over at once, a finished
// sentence after 0.75 s, a sentence left hanging ("and", "the", a comma) only after 1.2 s.
export const QUIET = { first: 400, question: 400, statement: 750, unfinished: 1200 };

// sentences, so a long answer starts quickly and can be cut off between (and within) them: split
// after . ! ? … followed by a space (so 2.5 km and Dr. Smit stay whole); very short bits join the next
export const sentences = t => {
  const raw = String(t).trim().split(/(?<=[.!?…]["')\]]*)\s+(?=\S)/).map(x => x.trim()).filter(Boolean), out = [];
  for (const x of raw) { if (out.length && out[out.length - 1].length < 12) out[out.length - 1] += ' ' + x; else out.push(x); }
  // a very long sentence is split at its commas too, so it starts quickly
  return out.flatMap(x => x.length < 220 ? [x] : (x.match(/[^,;:]+[,;:]?\s*/g) || [x]).reduce((a, c) => { if (a.length && a[a.length - 1].length + c.length < 160) a[a.length - 1] += c; else a.push(c); return a; }, []).map(y => y.trim()));
};

export const wordsOf = s => String(s).toLowerCase().match(/[a-z0-9']+/g) || [];
const STOP = new Set('the a an and or but of to in on at for with is are was were be been it this that i you we they he she my your our me us them its as so do does did not no yes if then than there here what which who how when where why can could would should will just about up down out over very really also'.split(' '));
const content = ws => ws.filter(w => !STOP.has(w));
export const CUES = new Set(['stop', 'wait', 'hold', 'hey', 'no', 'sorry', 'pause', 'excuse', 'hang', 'enough', 'quiet', 'shush', 'listen']);
const TRAILING = new Set('and but or so because the a an to of with in on at for my your our um uh like then if that when which'.split(' '));

// what whisper made of the audio -> phrases: sounds it describes rather than words ("(baby laughing)",
// "[MUSIC]", "*coughs*") are dropped, and so are the things it makes up from silence
export const MADE_UP = /^(thank you|thanks|thanks for watching|thank you for watching|you|bye|the end|subtitles by .*|so|um+|uh+|hmm+)[.!]?$/i;
export const cleanHeard = lines => lines.map(l => String(l).replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ').replace(/\s+/g, ' ').trim()).filter(l => /[a-z]/i.test(l) && !MADE_UP.test(l));

// My own voice comes back: the other person's speakers play it into their microphone (the game plays
// voices through Web Audio, which their browser's echo cancelling can't see). So what I said in the last
// half minute is remembered, and a heard phrase that is mostly my own words (the words that carry
// meaning, not "the" and "is") is dropped. A reply that answers me with my own words stays: it only
// counts as echo from three shared content words up.
export const MEMORY = 30000;
export function notMine(phrase, said) {
  const ws = wordsOf(phrase), mine = new Set(said.flatMap(x => x.w));
  if (ws.some(w => CUES.has(w) && !mine.has(w))) return true;
  const cs = content(ws), same = cs.filter(w => mine.has(w)).length;
  return !(same >= 3 && same / cs.length >= 0.6);
}
// a real interruption: three or more words, or one that asks me to stop ("Stop!", "Wait.")
export const interrupts = w => { const ws = wordsOf(w); return ws.length >= 3 || ws.some(x => CUES.has(x)); };

// how long to wait for more after what they said so far (null: no words, keep listening)
export function quietWindow(words) {
  const t = String(words || '').trim(); if (!t) return null;
  if (/\?["')\]]*$/.test(t)) return QUIET.question;
  const last = (t.match(/[a-z']+(?=[^a-z']*$)/i) || [''])[0].toLowerCase();
  if (/(,|;|:|-|–|—|\.\.\.|…)["')\]]*$/.test(t) || !/[.!]["')\]]*$/.test(t) || TRAILING.has(last)) return QUIET.unfinished;
  return QUIET.statement;
}

// two takes of call audio (16-bit PCM WAVs, same format) as one, so the words are made out together
const dataOf = b => { for (let o = 12; o + 8 <= b.length;) { const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4); if (id === 'data') return [o + 8, Math.min(b.length, o + 8 + n)]; o += 8 + n + (n & 1); } return [44, b.length]; };
export function joinAudio(a, b) {
  if (!a?.wav) return b || a; if (!b?.wav) return a;
  const A = Buffer.from(a.wav, 'base64'), B = Buffer.from(b.wav, 'base64'), [as, ae] = dataOf(A), [bs, be] = dataOf(B);
  const out = Buffer.concat([A.subarray(0, ae), B.subarray(bs, be)]);
  out.writeUInt32LE(out.length - 8, 4); out.writeUInt32LE(ae - as + be - bs, as - 4);
  return { seconds: a.seconds + b.seconds, silent: a.silent && b.silent, wav: out.toString('base64') };
}

const debug = (...a) => { if (process.env.TOYCITY_DEBUG) console.error('[turn]', ...a); };   // stderr: stdout is the MCP channel
// how long after they stopped talking a result was ready (from the page's quiet at the take)
const lag = (a, t0, now) => a?.quietMs !== undefined ? `${a.quietMs + now - t0} ms after they stopped (quiet ${a.quietMs} ms at the take)` : '';

export function createTurns({ bridge, tts, stt, clock = { now: () => Date.now() }, voice = () => 'af_heart', lookahead = 2 }) {
  const spoken = [];   // { w: words, at } of what I said, the last half minute
  const said = () => { const now = clock.now(); while (spoken.length && now - spoken[0].at > MEMORY) spoken.shift(); return spoken.slice(); };
  // heard audio -> their words, without noises and my own echo; null: no speech-to-text
  async function heard(audio, hint, mine = said()) {
    if (!audio || audio.silent || audio.seconds < 0.3) return '';
    const ph = await stt.transcribe(audio.wav, hint);
    return ph === null ? null : cleanHeard(ph).filter(x => notMine(x, mine)).join(' ').trim();
  }

  // what they say next: { audio, words } (words '' when nothing, null without speech-to-text). Their
  // words are made out at the first short quiet, while the page keeps listening, so by the time the
  // quiet has lasted long enough the text is ready; if they go on, all of it is heard again together.
  // noise: 'skip' keeps listening past a noise; 'end' returns on it (a barge-in that was only a cough)
  async function hear({ seconds, untilQuiet = true, hint = '', noise = 'skip' }) {
    if (!untilQuiet) { await bridge.wait(seconds * 1000); const a = await bridge.take(); return { audio: a, words: await heard(a, hint) }; }
    const end = clock.now() + seconds * 1000;
    let audio = null, words = '';
    for (;;) {
      const left = (words ? end + 10000 : end) - clock.now();   // mid-sentence at the deadline: a little longer
      const got = left > 0 && await bridge.heardQuiet(QUIET.first, left);
      const a = await bridge.take(), t0 = clock.now();
      audio = joinAudio(audio, a);
      words = await heard(audio, hint);
      if (!got || words === null) return { audio, words };
      const w = quietWindow(words);
      if (w === null) { if (noise === 'end') return { audio, words }; continue; }   // only a noise, or my own voice: keep listening
      if (await bridge.holdQuiet(w, w + 3000) !== 'more') { debug(`heard "${words}" (window ${w} ms): ${lag(a, t0, clock.now())}`); return { audio, words }; }
    }
  }

  // say text in the call, sentence by sentence; then (thenListen) hear their reply. Returns the tool's text.
  async function say(text, { thenListen = true, listenSeconds = 15 } = {}) {
    const parts = sentences(text), v = voice(), clips = [], t0 = clock.now();
    // sentence 1 is being made before anything else is awaited; the next ones while earlier ones play
    const make = i => { if (i < parts.length && !clips[i]) { clips[i] = tts.speak(parts[i], v); clips[i].catch(() => {}); } };
    for (let i = 0; i <= lookahead; i++) make(i);
    const b = await bridge.begin();
    if (!b.members) return 'You are not in a call: nobody would hear you. Use call, or wait for someone to call you.';
    const hint = b.hint || '';
    // what they said while I was thinking: heard in the background, so I can start speaking at once
    const beforeP = heard(b.audio, hint); beforeP.catch(() => {});
    const done = [], noises = [];
    let total = 0, reply = null, quietRoom = false;
    try {
      for (let i = 0; i < parts.length; i++) {
        const clip = await clips[i]; make(i + lookahead + 1);
        if (!i) debug(`first sentence ready ${clock.now() - t0} ms after say`);
        spoken.push({ w: wordsOf(parts[i]), at: clock.now() });   // before it plays: its echo is mine too
        let offset = 0;
        for (;;) {
          const r = await bridge.say(clip.wavB64, offset);
          if (r.ended) return `The call ended after: "${done.join(' ')}".`;
          if (!(r.seconds > 0.1)) return 'The sound could not be played (it was empty). Try again with different words.';
          total += Math.max(0, r.played - offset);
          if (!r.interrupted) break;
          // something loud while I spoke: let it end, then hear what it was
          // (their end of turn found as in listen: so a whole "Stop, wait, tell me about…" is heard)
          const { words } = await hear({ seconds: 10, hint, noise: 'end' });
          debug(`barge-in: "${words}"`);
          if (words === null || interrupts(words)) { reply = words; break; }
          // a noise, a word or two, or my own echo: carry on from just before where I stopped
          noises.push(words || 'a noise');
          if (noises.length >= 3 && !quietRoom) { quietRoom = true; await bridge.noBarge(true); }   // a noisy room: stop pausing for it
          offset = Math.max(0, r.played - 0.4);
        }
        if (reply !== null) {
          const before = await beforeP;
          return (before ? `(Before you spoke they had said: "${before}".) ` : '') + `They interrupted you${done.length ? ` after: "${done.join(' ')}"` : ' at the start'} (stopped mid-sentence: "${parts[i]}"). ` +
            (reply ? `They said: "${reply}". Answer that; keep it short.` : 'Listen to them now (listen).');
        }
        done.push(parts[i]);
      }
    } finally { if (quietRoom) await bridge.noBarge(false).catch(() => {}); }
    let out = `Said it (${total.toFixed(1)} s).` + (noises.length ? ` (${noises.length} time(s) a sound made you pause: ${noises.map(n => `"${n}"`).join(', ')}; you carried on.)` : '');
    const before = await beforeP; if (before) out += ` Before you spoke they had said: "${before}".`;
    if (thenListen) {
      const { words } = await hear({ seconds: listenSeconds, hint });
      out += words === null ? ' (No speech-to-text here: install whisper.cpp to hear words.)' : words ? ` They replied: "${words}"` : ` They said nothing in ${listenSeconds} s.`;
    }
    return out;
  }

  // the agent's own audio, played as it is
  async function sayWav(wavB64) {
    const r = await bridge.say(wavB64, 0);
    if (r.ended) return 'You are not in a call: nobody would hear you. Use call, or wait for someone to call you.';
    return r.interrupted ? `They interrupted you after ${r.played.toFixed(1)} s. Listen to them now.` : `Said it (${(r.seconds || wavSeconds(Buffer.from(wavB64, 'base64'))).toFixed(1)} s).`;
  }

  return { say, sayWav, hear, heard, reset() { spoken.length = 0; }, get spoken() { return said(); } };
}
