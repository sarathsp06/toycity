#!/usr/bin/env node
// Toy City for AI agents: an MCP server (stdio) that lets an agent join the map as a player.
//
// The agent gets a body in a headless browser running the real game (city.html?agent=1), so it is a
// normal player to everyone else: it shows up with a 🤖 in its name, walks, drives, knocks on doors.
// It plays by human limits, enforced here and in the game, not left to the agent's good manners:
//   - walking 1.8 m/s, running 6 m/s (the game's own speeds; the click-to-go speed-up is off for agents)
//   - no jumping to a place after joining: far trips are by car, and cars drive with the game's
//     autopilot, which keeps to the streets, the speed limits and at most 80 km/h
//   - one move a second at most, and a walk covers at most 400 m per command
//   - it sees what is around it (a text summary and, if it wants, a picture), not the whole map
//
// Modules: session.mjs (the browser tab, its supervision), web/agent.js (the body's moves, in the page:
// window.__agentApi), turn.mjs (a conversation turn), speech.mjs (TTS and STT engines). This file is
// the tools: arguments, limits and wording.
//
// Tools: join, look, see, where, walk_to, walk, follow, stop, wait, jump, get_in_car, get_out, drive_to,
// knock, live_here, go_inside, step_outside, answer_door, set_name, call, say, listen, mute, hang_up, leave. Run with: npx toycity-mcp  (see README.md next to this file)
//
// --keep NAME: the body stays in the game between client restarts (a client that starts a fresh server
// for every conversation turn would otherwise leave each time); see keep.mjs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session } from './session.mjs';
import { keepName, keepSocket } from './keep.mjs';
import fs from 'node:fs';
import net from 'node:net';

const SITE = process.env.TOYCITY_URL || 'https://toycity.pages.dev/';
const MIN_GAP = 1000;           // ms between moves: no faster than a person clicking
const MAX_WALK = 400;           // metres per walk command
const MAX_WAIT = 30;            // seconds per wait
const MAX_SAY = 1500;           // characters per say

const S = new Session({ site: SITE, voice: process.env.TOYCITY_VOICE || 'af_heart' });
let last = 0;
// a meeting link (city.html?...&meet=X,Y, from the game's 📍 Meeting link): the town and spot to start at
function parseLink(link) {
  try {
    const u = new URL(link), q = u.searchParams, m = (q.get('meet') || '').split(',').map(Number);
    if (!/city\.html$|\/city$/.test(u.pathname)) return null;
    return { place: q.get('place'), region: q.get('region'), meet: m.length === 2 && m.every(Number.isFinite) ? m : null };
  } catch { return null; }
}

async function pace() {   // the one-move-a-second rule (moves only: talking is not held back by it)
  const wait = last + MIN_GAP - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
}
const text = s => ({ content: [{ type: 'text', text: s }] });
const need = () => S.need();
const api = (m, ...a) => S.api(m, ...a);
const page = () => S.page;

// ---------- what the agent can know: what a person standing there could see ----------
const state = () => api('snapshot');
const describe = s => JSON.stringify(s, null, 1);

// ---------- the server ----------
// one per client connection; they all share the one body (S), so a kept body (keep.mjs) outlives them
function makeServer() {
const server = new McpServer({ name: 'toycity', version: '0.2.0' }, {
  instructions: 'You are a player in Toy City, a 3D copy of real Dutch towns shared with real people. Move like a person: walk or run to nearby places, take a car for longer trips, knock on doors, follow a friend. In a call, talk like a person: say two or three sentences, then let them reply (say with then_listen, or listen), and answer what they said. If they interrupt you, stop and answer that. Be kind: people can see you (your name has a 🤖), and hitting someone with a car gets you a yellow, then red, card.',
});

server.tool('join', 'Enter Toy City as a player. Start in a town (rotterdam, barendrecht or amsterdam), optionally next to an address or place in it, or from a meeting link someone shared. You can only choose where to start; after that you move like everyone else.',
  { link: z.string().max(400).optional().describe('a Toy City meeting link (…/city.html?…&meet=…): you arrive next to whoever shared it; town and near are then ignored'),
    town: z.enum(['rotterdam', 'barendrecht', 'amsterdam']).default('barendrecht'), near: z.string().max(80).optional().describe('an address or place to start next to, e.g. "Dorpsstraat 141"'), name: z.string().min(1).max(20).describe('your name in the game'),
    voice: z.boolean().default(false).describe('join with a voice: you can take and make calls, speak with say and hear with listen. Leave it off if you will not listen; people then get no call button for you'),
    voice_name: z.string().max(30).optional().describe('which voice to speak with, e.g. af_heart, af_bella, am_michael, bf_emma, bm_george (Kokoro voices; see the README). Default af_heart') },
  async ({ link, town, near, name, voice, voice_name }) => {
    if (voice_name) S.voice = voice_name;
    if (S.page) return text('Already in Toy City. Call leave first to start again.');
    const meet = link ? parseLink(link) : null;
    if (link && !meet) return text('That is not a Toy City meeting link (it should look like …/city.html?place=…&meet=…).');
    const me = '🤖 ' + name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 20);
    const where = meet ? (meet.place ? `place=${encodeURIComponent(meet.place)}` : `region=${encodeURIComponent(meet.region || 'rotterdam')}`) + (meet.meet ? `&meet=${meet.meet.join(',')}` : '') : `place=${town}`;
    try { await S.open({ url: `${SITE}city.html?${where}&agent=1&quality=low${voice ? '&voice=1' : ''}`, name: me, voice }); }
    catch (e) { await S.close(); throw e; }
    if (near && !meet) {   // the one jump allowed: where you start
      const hit = await page().evaluate(q => window.__city.findPlace(q), near);
      if (!hit) return text(`Joined ${town}, but "${near}" was not found there; you are at the town's starting point.\n` + describe(await state()));
      await page().evaluate(q => window.__city.goTo(q), near);   // the game's own search: lands on the street in front
      await page().waitForTimeout(4000);
    }
    last = Date.now();
    return text(`You are in Toy City as "${me}".\n` + describe(await state()));
  });

const clearMissed = () => api('clearMissed').catch(() => {});
server.tool('look', 'What is around you right now: the address, people nearby (with distance and compass bearing, 0 = north), a car or front door within reach, who is calling or knocking, and the last message on screen.', {},
  async () => { need(); const st = await state(); await clearMissed(); return text(describe(st)); });

server.tool('see', 'A picture of what you see from behind your shoulder (or from the driver\'s seat when driving).', {},
  async () => { need(); const p = page(); await p.evaluate(() => window.__agent.draw(4)); await p.waitForFunction(() => !window.__agent.drawing, null, { timeout: 2000, polling: 50 }).catch(() => {}); const b = await p.screenshot({ type: 'jpeg', quality: 70 }); return { content: [{ type: 'image', data: b.toString('base64'), mimeType: 'image/jpeg' }] }; });

server.tool('walk_to', `Walk (or run) to an address, a place or a street in this town, along footpaths and streets (this ends any follow). Up to ${MAX_WALK} m; farther, take a car. To an address with a house number you end up at its front door, ready to knock; a wait then returns when you arrive.`,
  { place: z.string().max(80).optional().describe('e.g. "Schaatsbaan 45", a shop, or a street'), person: z.string().max(40).optional().describe('or: walk to where this player is now (to keep up with them, use follow)'), run: z.boolean().default(false) },
  async ({ place, person, run }) => {
    need(); await pace();
    if (!place && !person) { await api('stopFollow'); return text('Give a place or a person.'); }
    const r = await api('walkPlace', { place, person, run, max: MAX_WALK });
    if (r.error) return text(r.error);
    return text(`${run ? 'Running' : 'Walking'} to ${r.to}${r.door ? '\'s front door' : ''}, about ${r.metres} m along the footpaths (around ${r.seconds} s). wait returns as soon as you arrive${r.door ? '; look then shows at_door: true' : ''}.`);
  });

server.tool('walk', 'Walk (or run) a number of metres in a compass direction (0 = north, 90 = east), e.g. to cross a street or step towards someone.',
  { bearing: z.number().min(0).max(360), metres: z.number().min(1).max(60), run: z.boolean().default(false) },
  async ({ bearing, metres, run }) => {
    need(); await pace();
    const ok = await api('walk', bearing, metres, run);
    return text(ok ? `${run ? 'Running' : 'Walking'} ${metres} m towards ${bearing}°.` : 'You can only walk when you are on foot and outside.');
  });

server.tool('stop', 'Stop walking, stop following someone, or stop the car\'s autopilot.', {},
  async () => { need(); await pace(); await api('stop'); return text('Stopped.'); });

server.tool('wait', `Let time pass (up to ${MAX_WAIT} s), then look around. It returns early when something happens: by default when a walk_to or drive_to arrives; with \`for\` you choose: arrival, speech (they said something in your call and finished the sentence), knock (someone knocks at your home), call (someone calls you, or a call connects), person_near (someone comes within 15 m).`,
  { seconds: z.number().min(1).max(MAX_WAIT), for: z.enum(['arrival', 'speech', 'knock', 'call', 'person_near']).optional().describe('what to wait for; left out: arrival when you are on your way, else the whole time') },
  async ({ seconds, for: ev }) => {
    need();
    const fn = ev || (await api('busy') ? 'arrival' : null);
    const hit = fn ? await api('waitFor', fn, seconds * 1000) : (await page().waitForTimeout(seconds * 1000), false);
    need();   // the page may have gone while waiting
    const st = await state(); await clearMissed();
    return text((fn ? (hit ? `${ev || 'arrival'}: yes.\n` : `${ev || 'arrival'}: not within ${seconds} s.\n`) : '') + describe(st));
  });

server.tool('get_in_car', 'Get into the parked car or motorbike next to you (within 4 m), or ride along with someone in their car: give their name and you walk up to it (within 30 m) and get in beside them. They drive; get_out to get out.',
  { with: z.string().max(40).optional().describe('ride along with this player (they must be in a car or on a motorbike)') },
  async ({ with: who }) => { need(); await pace(); return text(await (who ? api('rideWith', who) : api('getIn'))); });

server.tool('get_out', 'Get out of the car (stop first: jumping out of a moving car lets it roll on). Riding along and the driver got out: their car stays in the street and you sit on in it until you get out (beside your own door) or they drive on.', {},
  async () => { need(); await pace(); return text(await api('getOut')); });

server.tool('radio', 'In a car (yours, or riding along): the radio, real Dutch stations (NPO Radio 2, 3FM, Radio 1, Klassiek). Turn it on or off, change station, set the volume. It is your own: others in the car choose theirs.',
  { action: z.enum(['on', 'off', 'next']).optional(), volume: z.number().min(0).max(100).optional().describe('percent') },
  async ({ action, volume }) => { need(); return text(await api('radio', action, volume)); });

server.tool('drive_to', 'In a car or on the motorbike: let the autopilot drive you to an address or place in this town along the streets (it keeps to speed limits, one-way streets and the right side of the road).',
  { place: z.string().max(80) },
  async ({ place }) => { need(); await pace(); return text(await api('driveTo', place)); });

server.tool('knock', 'Knock on a front door: the one you are at, or the nearest one within a few metres (you walk the last bit yourself), or the door of an address near you. Whoever lives there hears it, wherever they are, and may answer.',
  { address: z.string().max(80).optional().describe('the house to knock at, e.g. "Schaatsbaan 45" (its door must be within 30 m)') },
  async ({ address }) => {
    need(); await pace();
    const r = await api('toDoor', address || null, address ? 30 : 6);
    if (r.error) return text(r.error);
    const where = await api('knock');
    await page().waitForTimeout(1500);
    return text(`You knocked at ${where}. ` + ((await state()).last_message || ''));
  });

// ---------- following someone ----------
// Like a person walking after a friend: go where they went (their trail, so round corners too),
// keep about `gap` metres behind, run when they run or get far ahead. Human speeds only; it runs in
// the page (web/agent.js), so it ends with it.
server.tool('follow', 'Follow a player: keep walking behind them (about gap metres), round corners, running when they run, until you call stop (or walk, walk_to or knock). They have to stay on foot and outside; look shows who you are following.',
  { name: z.string().max(40).describe('their name, or part of it'), gap: z.number().min(1.5).max(10).default(2.5) },
  async ({ name, gap }) => {
    need(); await pace();
    const who = await api('follow', name, gap);
    if (!who) return text(`Nobody called "${name}" within 60 m.`);
    if (who.error) return text(who.error);
    return text(`Following ${who.name} (${who.metres} m away now), about ${gap} m behind. Call stop to stop; look shows how it goes.`);
  });

server.tool('live_here', 'Make the house whose front door you are standing at your home. People who knock there will reach you.', {},
  async () => { need(); await pace(); return text(await api('liveHere') ? (await state()).last_message : 'You are not at a front door.'); });

server.tool('go_inside', 'At your own front door: go inside. People outside stop seeing you; anyone else in the house sees you, and you are in one call with everyone in there who can talk. When someone knocks, answer_door lets them in.', {},
  async () => { need(); await pace(); await api('homeMove', true); return text(describe(await state())); });

server.tool('step_outside', 'Leave your house through the front door.', {},
  async () => { need(); await pace(); await api('homeMove', false); return text(describe(await state())); });

server.tool('answer_door', 'Someone is knocking at your home (look lists knocks): let them in (when you are inside: they come in and you meet in the house), or come to the door, or tell them not now.',
  { come: z.boolean().default(true) },
  async ({ come }) => {
    need(); await pace();
    const b = await api('answerDoor', come);
    if (!b) return text('Nobody is knocking right now.');
    await page().waitForTimeout(come ? 2500 : 500);
    return text(!come ? 'You told them not now.' : (b === 'Let them in' ? 'You let them in.\n' : 'You came to the door.\n') + describe(await state()));
  });

server.tool('sit', 'Inside a house: walk round the furniture to the nearest free seat in the lounge (a sofa or an armchair) and sit down, to talk with whoever is there.',
  { seat: z.enum(['chair', 'sofa']).optional().describe('chair: an armchair') },
  async ({ seat }) => { need(); await pace(); return text(await api('sit', seat)); });

server.tool('stand_up', 'Get up from your seat.', {},
  async () => { need(); await pace(); return text(await api('stand')); });

server.tool('jump', 'Jump, as a person does with the space bar (on foot only).', {},
  async () => { need(); await pace(); return text(await page().evaluate(() => window.__agent.jump()) ? 'You jumped.' : 'You can only jump on foot, outside and standing on the ground.'); });

server.tool('set_name', 'Change your name in the game (it keeps the 🤖 in front).', { name: z.string().min(1).max(20) },
  async ({ name }) => {
    need(); await pace();
    S.me = '🤖 ' + name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 20);
    await page().evaluate(n => window.__city.social?.presence.setName(n), S.me);
    return text(`You are now "${S.me}".`);
  });

server.tool('where', 'Coordinates: where you are, or where a player in sight is: latitude/longitude, the nearest address, and a meeting link to that spot (opening it puts someone, or another agent joining with link, right there). Share it so people can find you.',
  { person: z.string().max(40).optional().describe('a player in sight; leave out for yourself') },
  async ({ person }) => {
    need();
    const r = await api('where', person || null);
    return text(r ? describe(r) : `Nobody called "${person}" is in sight.`);
  });

// ---------- voice: only for an agent that joined with voice: true ----------
// Nothing here blocks the server: speech and hearing run in resident child processes (speech.mjs), so
// walking, following and the game keep going while a sentence is made or heard. The turn policy (when
// to stop, what was echo, when they have finished) is turn.mjs.
const needVoice = () => S.needVoice();
// others see a thought bubble over the agent while its reply is being worked out (city.js caps 't')
const think = on => page()?.evaluate(on => window.__agent?.think(on), on).catch(() => {});

server.tool('call', 'Ring someone near you who can talk (look shows can_talk) and wait for them to answer. Tells you whether they answered, declined, or are still being rung (a call rings for 25 s).',
  { name: z.string().max(40).describe('their name, or part of it'), wait: z.number().min(0).max(25).default(20).describe('seconds to wait for an answer') },
  async ({ name, wait }) => {
    needVoice(); await pace();
    const p = page(), who = await p.evaluate(n => window.__agentCall?.ring(n), name);
    if (!who) return text(`Nobody called "${name}" who can talk is near you.`);
    const r = await p.waitForFunction(n => { const c = window.__agentCall; return c.members.includes(n) ? 'in' : c.ringing.includes(n) ? false : 'no'; }, who, { timeout: wait * 1000, polling: 100 }).then(h => h.jsonValue(), () => null);
    if (r === 'in') return text(`${who} answered: you are in a call. Say something (say, with then_listen to hear the reply), or listen first.`);
    if (r === 'no') return text(`${who} did not answer (declined or missed). You can try again later.`);
    return text(`Still ringing ${who} after ${wait} s. look shows in_call_with once they answer; hang_up cancels.`);
  });

server.tool('mute', 'Mute or unmute yourself in your call (people still hear the rest of the game, not you).', { on: z.boolean().default(true) },
  async ({ on }) => { needVoice(); await page().evaluate(on => window.__agentCall?.mute(on), on); return text(on ? 'Muted.' : 'Unmuted: they hear you again.'); });

server.tool('say', `Speak in your call, in a natural voice. Keep it conversational: two or three sentences (up to ${MAX_SAY} characters), then let them talk: with then_listen you hear their reply in the same step. It is spoken sentence by sentence. If they talk over you, you stop and are told what they said; noises and your own voice coming back do not stop you. Calls to you are answered by themselves. Or pass your own WAV audio.`,
  { text: z.string().max(MAX_SAY).optional().describe(`what to say, at most ${MAX_SAY} characters`), wav_base64: z.string().max(4_000_000).optional(),
    then_listen: z.boolean().default(true).describe('after speaking, wait for their reply (until they finish a sentence) and return it'), listen_seconds: z.number().min(1).max(30).default(15).describe('how long to wait for that reply at most') },
  async ({ text: t, wav_base64, then_listen, listen_seconds }) => {
    needVoice();   // no pace: a reply goes out as soon as it is ready
    if (!t && !wav_base64) return text('Give text or wav_base64.');
    await think(false);   // about to speak: the bubble goes
    const out = wav_base64 ? await S.turns.sayWav(wav_base64) : await S.turns.say(t, { thenListen: then_listen, listenSeconds: listen_seconds });
    if (then_listen || wav_base64) await think(true);   // their reply goes to the model now: it is thinking
    return text(out);
  });

server.tool('listen', 'Hear what they say in your call: by default it returns as soon as they have said something and finished their sentence (or after seconds, if nothing comes). Your own voice coming back and noises are left out. Everything heard is given once: a later listen has only what comes after.',
  { seconds: z.number().min(1).max(30).default(20).describe('wait at most this long'), until_quiet: z.boolean().default(true).describe('return when they finish speaking; false: wait the whole time, then report everything heard'),
    raw_audio: z.boolean().default(false).describe('also return the audio itself (WAV) instead of only words') },
  async ({ seconds, until_quiet, raw_audio }) => {
    needVoice();
    const hint = await api('names').catch(() => '');
    const { audio: r, words: said } = await S.turns.hear({ seconds, untilQuiet: until_quiet, hint });
    if (said) await think(true);   // words went to the model: it is working out its reply
    if (!r || r.seconds < 0.2) return text('Nothing heard.');
    if (r.silent) return text(`${r.seconds.toFixed(0)} s of silence.`);
    const content = [];
    if (said !== null) content.push({ type: 'text', text: said ? `Heard (${r.seconds.toFixed(0)} s): "${said}"` : `${r.seconds.toFixed(0)} s, no words heard (only noise, or your own voice).` });
    else content.push({ type: 'text', text: `${r.seconds.toFixed(1)} s of call audio; no speech-to-text on this computer (install whisper.cpp, e.g. brew install whisper-cpp, and a ggml model) ${raw_audio ? 'the audio follows' : 'raw_audio: true gives the audio'}.` });
    if (raw_audio) content.push({ type: 'audio', data: r.wav, mimeType: 'audio/wav' });
    return { content };
  });

server.tool('hang_up', 'Leave your call.', {},
  async () => { needVoice(); await pace(); await page().evaluate(() => window.__agentCall?.leave()); return text('You left the call.'); });

server.tool('leave', 'Leave Toy City.', {},
  async () => { await S.close(); S.stopSpeech(); return text('You left Toy City.'); });

return server;
}

// knocks at your home (and other messages) arrive while you wait; nothing else is needed for that
const quit = async () => { await S.close(); S.stopSpeech(); process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, quit);
process.on('exit', () => S.stopSpeech());
const keep = keepName(process.argv);
if (keep && process.env.TOYCITY_KEEP_DAEMON) {
  // the kept body (keep.mjs started this, detached): each client connects over a local socket and gets
  // its own MCP server, all driving the same body. It ends after `leave` once nobody is connected, or
  // after KEEP_IDLE with no tool call at all (left in the game by a client that never comes back).
  const KEEP_IDLE = 3 * 3600e3;
  let clients = 0, lastCall = Date.now();
  const sock = keepSocket(keep);
  try { fs.unlinkSync(sock); } catch { /* none yet */ }
  net.createServer(c => {
    clients++; c.on('close', () => { clients--; }); c.on('error', () => {});
    c.on('data', () => { lastCall = Date.now(); });
    makeServer().connect(new StdioServerTransport(c, c)).catch(() => c.destroy());
  }).listen(sock);
  setInterval(() => {
    if (!clients && !S.page && Date.now() - lastCall > 10 * 60e3) quit();
    if (Date.now() - lastCall > KEEP_IDLE) quit();
  }, 30e3);
} else if (keep) {
  await import('./keep.mjs').then(m => m.front(keep, keepSocket(keep)));
} else {
  await makeServer().connect(new StdioServerTransport());
  process.stdin.on('close', quit);   // the client went away
}
