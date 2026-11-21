#!/usr/bin/env node
// Toy City for AI agents: an MCP server (stdio) that lets an agent join the map as a player.
//
// The agent gets a body in a headless browser running the real game (city.html?agent=1), so it is a
// normal player to everyone else: it shows up with a 🤖 in its name, walks, drives, knocks on doors.
// It plays by human limits, enforced here and in the game, not left to the agent's good manners:
//   - walking 1.8 m/s, running 6 m/s (the game's own speeds; the click-to-go speed-up is off for agents)
//   - no jumping to a place after joining: far trips are by car, and cars drive with the game's
//     autopilot, which keeps to the streets, the speed limits and at most 80 km/h
//   - one action a second at most, and a walk covers at most 400 m per command
//   - it sees what is around it (a text summary and, if it wants, a picture), not the whole map
//
// Tools: join, look, see, walk_to, walk, stop, wait, get_in_car, get_out, drive_to, knock, live_here,
// go_inside, step_outside, answer_door, leave. Run with: npx toycity-mcp  (see README.md next to this file)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SITE = process.env.TOYCITY_URL || 'https://toycity.pages.dev/';
const MIN_GAP = 1000;           // ms between actions: no faster than a person clicking
const MAX_WALK = 400;           // metres per walk command
const MAX_WAIT = 30;            // seconds per wait

// ---------- the browser ----------
function chromePath() {
  if (process.env.TOYCITY_CHROME) return process.env.TOYCITY_CHROME;
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  const linux = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const win = ['C:/Program Files/Google/Chrome/Application/chrome.exe'];
  return [...mac, ...linux, ...win].find(p => fs.existsSync(p));
}
let browser = null, ctx = null, page = null, last = 0, me = null, hasVoice = false, lease = null, leaseT = null;

// the shared browser (browser-host.mjs): connect to it, or start it and then connect
const HOST_DIR = path.join(os.tmpdir(), 'toycity-browser'), HOST_INFO = path.join(HOST_DIR, 'endpoint.json');
async function sharedBrowser() {
  const tryConnect = async () => { try { const { ws } = JSON.parse(fs.readFileSync(HOST_INFO, 'utf8')); return await chromium.connect(ws, { timeout: 5000 }); } catch { return null; } };
  let b = await tryConnect(); if (b) return b;
  const exe = chromePath();
  spawn(process.execPath, [fileURLToPath(new URL('./browser-host.mjs', import.meta.url)), ...(exe ? [exe] : [])], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60 && !b; i++) { await new Promise(r => setTimeout(r, 500)); b = await tryConnect(); }
  if (!b) throw new Error('Could not start the browser. Is Chrome or Chromium installed? Set TOYCITY_CHROME to its path.');
  return b;
}
function keepLease(on) {
  clearInterval(leaseT);
  if (!on) { if (lease) fs.rmSync(lease, { force: true }); lease = null; return; }
  fs.mkdirSync(HOST_DIR, { recursive: true }); lease = path.join(HOST_DIR, `${process.pid}.lease`);
  const touch = () => fs.writeFileSync(lease, String(Date.now())); touch(); leaseT = setInterval(touch, 30000);
}
async function leaveGame() { keepLease(false); await ctx?.close().catch(() => {}); await browser?.close().catch(() => {}); browser = ctx = page = null; }
// a meeting link (city.html?...&meet=X,Y, from the game's 📍 Meeting link): the town and spot to start at
function parseLink(link) {
  try {
    const u = new URL(link), q = u.searchParams, m = (q.get('meet') || '').split(',').map(Number);
    if (!/city\.html$|\/city$/.test(u.pathname)) return null;
    return { place: q.get('place'), region: q.get('region'), meet: m.length === 2 && m.every(Number.isFinite) ? m : null };
  } catch { return null; }
}

async function pace() {   // the one-action-a-second rule
  const wait = last + MIN_GAP - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
}
const text = s => ({ content: [{ type: 'text', text: s }] });
const need = () => { if (!page) throw new Error('Not in Toy City yet: call join first.'); };
const inPage = (fn, arg) => page.evaluate(fn, arg);

// ---------- what the agent can know: what a person standing there could see ----------
async function state() {
  return inPage(() => {
    const c = window.__city, p = c.player.position, d = c.driving, h = c.homes;
    const ps = [...(c.social?.presence.peers.values() || [])].filter(q => q.player?.group.visible && q.dist < 60).map(q => {
      const g = q.player.group.position, dx = g.x - p.x, dz = g.z - p.z;
      return { name: q.name || 'Visitor', metres: Math.round(Math.hypot(dx, dz)), bearing: Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360),
        doing: q.player.inside ? 'riding in a car' : q.car ? (q.car.startsWith('bike') ? 'on a motorbike' : 'driving') : q.pose === 2 ? 'lying on the ground' : q.speed > 2.5 ? 'running' : q.speed > 0.3 ? 'walking' : 'standing',
        card: q.card === 2 ? 'red card' : q.card === 1 ? 'yellow card' : undefined,
        can_talk: q.caps === undefined ? !(q.name || '').startsWith('🤖') : q.caps.includes('v') };
    }).sort((a, b) => a.metres - b.metres);
    const car = !d.driving && d.nearest(p);
    const door = [...c.tiles.values()].flatMap(t => {
      if (!t.doors) return [];
      const out = [];
      for (let k = 0; k < t.doors.length; k += 6) { const x = t.doors[k] + t.group.position.x, z = t.doors[k + 2] + t.group.position.z, m = Math.hypot(x - p.x, z - p.z); if (m < 25) out.push(Math.round(m)); }
      return out;
    }).sort((a, b) => a - b)[0];
    return {
      at: c.nearestPlace().replace(/\s+·\s+/g, ', '),
      doing: h.inside ? 'at home, inside' : d.driving ? `${d.model === 'bike' ? 'riding a motorbike' : 'driving'} at ${Math.round(Math.abs(d.speed) * 3.6)} km/h${c.autopilot.active ? `, autopilot to ${c.autopilot.label}, ${(c.autopilot.remaining / 1000).toFixed(1)} km left` : ''}`
        : c.fling.on ? 'knocked over' : window.__agent.walking ? 'walking' : 'standing',
      facing: Math.round(((Math.atan2(-Math.sin(c.player.rotation.y), -Math.cos(c.player.rotation.y)) * 180 / Math.PI) * -1 + 360) % 360),
      home: h.home ? h.home.label : null,
      people: ps,   // each with can_talk: whether they have a voice (you can call them)
      car_nearby: car ? `a parked ${car.model?.name === 'bike' ? 'motorbike' : 'car'} ${Math.round(Math.hypot(car.x - p.x, car.z - p.z))} m away` : null,
      front_door: door !== undefined ? `${door} m away` : null,
      at_door: !!document.getElementById('doorbar') && !document.getElementById('doorbar').hidden,
      card: c.card.level === 2 ? 'red' : c.card.level === 1 ? 'yellow' : null,
      missed_calls: (window.__agentCalls || []).splice(0),   // people who tried to call you while you had no voice
      in_call_with: window.__agentCall?.members || [],
      calling: window.__agentCall?.ringing || [],
      knocks: [...document.querySelectorAll('#mptoasts .toast')].map(t => t.firstChild?.textContent).filter(t => /knocking/.test(t || '')),
      last_message: document.getElementById('hint')?.classList.contains('gone') ? null : document.getElementById('hint')?.textContent,
    };
  });
}
const describe = s => JSON.stringify(s, null, 1);

// ---------- the server ----------
const server = new McpServer({ name: 'toycity', version: '0.1.0' }, {
  instructions: 'You are a player in Toy City, a 3D copy of real Dutch towns shared with real people. Move like a person: walk or run to nearby places, take a car for longer trips, knock on doors. Be kind: people can see you (your name has a 🤖), and hitting someone with a car gets you a yellow, then red, card.',
});

server.tool('join', 'Enter Toy City as a player. Start in a town (rotterdam, barendrecht or amsterdam), optionally next to an address or place in it, or from a meeting link someone shared. You can only choose where to start; after that you move like everyone else.',
  { link: z.string().max(400).optional().describe('a Toy City meeting link (…/city.html?…&meet=…): you arrive next to whoever shared it; town and near are then ignored'),
    town: z.enum(['rotterdam', 'barendrecht', 'amsterdam']).default('barendrecht'), near: z.string().max(80).optional().describe('an address or place to start next to, e.g. "Dorpsstraat 141"'), name: z.string().min(1).max(20).describe('your name in the game'),
    voice: z.boolean().default(false).describe('join with a voice: you can take and make calls, speak with say and hear with listen. Leave it off if you will not listen; people then get no call button for you') },
  async ({ link, town, near, name, voice }) => {
    if (page) return text('Already in Toy City. Call leave first to start again.');
    const meet = link ? parseLink(link) : null;
    if (link && !meet) return text('That is not a Toy City meeting link (it should look like …/city.html?place=…&meet=…).');
    browser = await sharedBrowser(); keepLease(true);
    hasVoice = voice;
    ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
    me = '🤖 ' + name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 20);
    await ctx.addInitScript(n => { localStorage.setItem('toycity.name', n); localStorage.setItem('toycity.view', 'chase'); }, me);
    page = await ctx.newPage();
    const where = meet ? (meet.place ? `place=${encodeURIComponent(meet.place)}` : `region=${encodeURIComponent(meet.region || 'rotterdam')}`) + (meet.meet ? `&meet=${meet.meet.join(',')}` : '') : `place=${town}`;
    await page.goto(`${SITE}city.html?${where}&agent=1&quality=low${voice ? '&voice=1' : ''}`);
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__agent, null, { timeout: 120000 });
    if (near && !meet) {   // the one jump allowed: where you start
      const hit = await inPage(q => window.__city.findPlace(q), near);
      if (!hit) return text(`Joined ${town}, but "${near}" was not found there; you are at the town's starting point.\n` + describe(await state()));
      await inPage(q => window.__city.goTo(q), near);   // the game's own search: lands on the street in front
      await page.waitForTimeout(4000);
    }
    last = Date.now();
    return text(`You are in Toy City as "${me}".\n` + describe(await state()));
  });

server.tool('look', 'What is around you right now: the address, people nearby (with distance and compass bearing, 0 = north), a car or front door within reach, and the last message on screen.', {},
  async () => { need(); return text(describe(await state())); });

server.tool('see', 'A picture of what you see from behind your shoulder (or from the driver\'s seat when driving).', {},
  async () => { need(); await pace(); await inPage(() => window.__agent.draw(4)); await page.waitForTimeout(600); const b = await page.screenshot({ type: 'jpeg', quality: 70 }); return { content: [{ type: 'image', data: b.toString('base64'), mimeType: 'image/jpeg' }] }; });

server.tool('walk_to', `Walk (or run) to an address, a place or a street in this town, along footpaths and streets. Up to ${MAX_WALK} m; farther, take a car.`,
  { place: z.string().max(80), run: z.boolean().default(false) },
  async ({ place, run }) => {
    need(); await pace();
    const r = await inPage(async ([q, run, max]) => {
      const c = window.__city, hit = await c.findPlace(q); if (!hit) return { error: `"${q}" not found in this town.` };
      if (c.driving.driving) return { error: 'You are in a car: use drive_to, or get_out first.' };
      const x = hit[0] - c.ORX, z = -(hit[1] - c.ORY), p = c.player.position, d = Math.hypot(x - p.x, z - p.z);
      if (d > max) return { error: `${hit[2]} is ${Math.round(d)} m away: too far to walk in one go. Take a car (get_in_car, then drive_to).` };
      const pts = (await c.autopilot.plan({ x: p.x, z: p.z, fx: 0, fz: -1 }, { x, z }, 'foot').catch(() => null)) || [[x, z]];
      window.__agentWalk = { pts, i: 0, run };
      return { to: hit[2], metres: Math.round(d), seconds: Math.round(d / (run ? 6 : 1.8) * 1.3) };
    }, [place, run, MAX_WALK]);
    if (r.error) return text(r.error);
    await followWalk();
    return text(`${run ? 'Running' : 'Walking'} to ${r.to}, about ${r.metres} m (around ${r.seconds} s). Use wait or look to follow along.`);
  });

server.tool('walk', 'Walk (or run) a number of metres in a compass direction (0 = north, 90 = east), e.g. to cross a street or step towards someone.',
  { bearing: z.number().min(0).max(360), metres: z.number().min(1).max(60), run: z.boolean().default(false) },
  async ({ bearing, metres, run }) => {
    need(); await pace();
    const ok = await inPage(([b, m, run]) => { const c = window.__city, p = c.player.position, a = b * Math.PI / 180; window.__agentWalk = null; return window.__agent.walkTo(p.x + Math.sin(a) * m, p.z - Math.cos(a) * m, run); }, [bearing, metres, run]);
    return text(ok ? `${run ? 'Running' : 'Walking'} ${metres} m towards ${bearing}°.` : 'You can only walk when you are on foot and outside.');
  });

// a planned walk goes point by point: the next point is set when the last one is reached
let walker = null;
async function followWalk() {
  clearInterval(walker);
  walker = setInterval(async () => {
    if (!page) return clearInterval(walker);
    const more = await inPage(() => {
      const w = window.__agentWalk; if (!w) return false;
      if (window.__agent.walking) return true;
      if (++w.i >= w.pts.length) { window.__agentWalk = null; return false; }
      const [x, z] = w.pts[w.i]; window.__agent.walkTo(x, z, w.run); return true;
    }).catch(() => false);
    if (!more) clearInterval(walker);
  }, 250);
}

server.tool('stop', 'Stop walking, or stop the car\'s autopilot.', {},
  async () => { need(); await pace(); await inPage(() => { window.__agentWalk = null; window.__agent.stop(); const c = window.__city; if (c.autopilot.active) c.autopilot.stop(); }); return text('Stopped.'); });

server.tool('wait', `Let time pass (up to ${MAX_WAIT} s) while you walk, drive or listen, then look around.`,
  { seconds: z.number().min(1).max(MAX_WAIT) },
  async ({ seconds }) => { need(); await page.waitForTimeout(seconds * 1000); return text(describe(await state())); });

server.tool('get_in_car', 'Get into the parked car or motorbike next to you (within 4 m), or ride along with a friend who is driving right next to you.', {},
  async () => {
    need(); await pace();
    const r = await inPage(() => { const c = window.__city; if (c.driving.driving) return 'You are already driving.'; const car = c.driving.nearest(c.player.position); c.toggleCar(); return c.driving.driving ? `You are in the ${c.driving.model === 'bike' ? 'motorbike' : 'car'}.` : car ? 'Could not get in.' : 'No car within reach: walk closer to one first (look shows the nearest).'; });
    return text(r);
  });

server.tool('get_out', 'Get out of the car (stop first: jumping out of a moving car lets it roll on).', {},
  async () => { need(); await pace(); return text(await inPage(() => { const c = window.__city; if (!c.driving.driving) return 'You are not in a car.'; c.toggleCar(); return 'You got out.'; })); });

server.tool('drive_to', 'In a car or on the motorbike: let the autopilot drive you to an address or place in this town along the streets (it keeps to speed limits, one-way streets and the right side of the road).',
  { place: z.string().max(80) },
  async ({ place }) => {
    need(); await pace();
    const r = await inPage(async q => {
      const c = window.__city; if (!c.driving.driving) return 'You are not in a car: get_in_car first.';
      const hit = await c.findPlace(q); if (!hit) return `"${q}" not found in this town.`;
      await c.autoTo(hit[0] - c.ORX, -(hit[1] - c.ORY), hit[2]);
      return c.autopilot.active ? `Driving to ${hit[2]}, ${(c.autopilot.remaining / 1000).toFixed(1)} km. Use wait to follow along.` : 'No road there from here.';
    }, place);
    return text(r);
  });

server.tool('knock', 'Knock on the front door you are standing at. Whoever lives there hears it, wherever they are, and may answer.', {},
  async () => { need(); await pace(); const ok = await inPage(() => { const b = document.getElementById('doorbar'); if (b.hidden) return false; window.__city.homes.knock(); return true; }); await page.waitForTimeout(1500); return text(ok ? 'You knocked. ' + (await state()).last_message : 'You are not at a front door: walk up to one first (look shows the nearest).'); });

server.tool('live_here', 'Make the house whose front door you are standing at your home. People who knock there will reach you.', {},
  async () => { need(); await pace(); const ok = await inPage(() => { const b = document.getElementById('doorbar'); if (b.hidden) return false; window.__city.homes.liveHere(); return true; }); return text(ok ? (await state()).last_message : 'You are not at a front door.'); });

server.tool('go_inside', 'At your own front door: go inside. Others stop seeing you.', {},
  async () => { need(); await pace(); await inPage(() => window.__city.homes.goIn()); await page.waitForTimeout(2200); return text(describe(await state())); });

server.tool('step_outside', 'Leave your house through the front door.', {},
  async () => { need(); await pace(); await inPage(() => window.__city.homes.comeOut()); await page.waitForTimeout(2200); return text(describe(await state())); });

server.tool('answer_door', 'Someone is knocking at your home (look lists knocks): come to the door, or tell them not now.',
  { come: z.boolean().default(true) },
  async ({ come }) => {
    need(); await pace();
    const ok = await inPage(come => { const t = [...document.querySelectorAll('#mptoasts .toast')].find(t => /knocking/.test(t.textContent)); if (!t) return false; t.querySelectorAll('button')[come ? 0 : 1].click(); return true; }, come);
    if (!ok) return text('Nobody is knocking right now.');
    await page.waitForTimeout(come ? 2500 : 500);
    return text(come ? 'You came to the door.\n' + describe(await state()) : 'You told them not now.');
  });

// ---------- voice: only for an agent that joined with voice: true ----------
function speak(text) {   // text to a WAV file with the computer's own speech: macOS say, or espeak-ng / espeak
  const f = path.join(os.tmpdir(), `toycity-say-${process.pid}.wav`);
  if (process.platform === 'darwin') {
    // the system voice first; some voices (Siri ones) write an empty file, so then a classic voice
    for (const v of [[], ['-v', 'Samantha'], ['-v', 'Daniel']]) {
      try { execFileSync('say', [...v, '-o', f, '--data-format=LEI16@22050', text]); } catch { continue; }
      if (fs.existsSync(f) && fs.statSync(f).size > 2000) break;
    }
  }
  else { let ok = false; for (const c of ['espeak-ng', 'espeak']) { try { execFileSync(c, ['-w', f, text]); ok = true; break; } catch { /* next */ } } if (!ok) throw new Error('no text-to-speech here: install espeak-ng, or pass your own audio'); }
  if (!fs.existsSync(f) || fs.statSync(f).size <= 2000) throw new Error('Text-to-speech produced no sound on this computer.');
  const b = fs.readFileSync(f).toString('base64'); fs.rmSync(f, { force: true }); return b;
}

// speech to text, so the agent knows what was said: whisper.cpp (whisper-cli) with a ggml model,
// from TOYCITY_WHISPER_MODEL or a usual place. Without it, listen gives the audio itself.
function whisperModel() {
  const home = os.homedir(), cands = [process.env.TOYCITY_WHISPER_MODEL, ...['.cache/whisper', '.cache/hyperframes/whisper/models', '.whisper', 'Library/Application Support/whisper']
    .flatMap(d => { try { return fs.readdirSync(path.join(home, d)).filter(f => /^ggml-.*\.bin$/.test(f)).map(f => path.join(home, d, f)); } catch { return []; } }),
    '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin', '/usr/local/share/whisper-cpp/ggml-base.en.bin'].filter(Boolean);
  return cands.find(f => fs.existsSync(f));
}
function transcribe(wavB64) {
  const model = whisperModel(); if (!model) return null;
  const bin = ['whisper-cli', 'whisper-cpp', 'main'].find(b => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!bin) return null;
  const f = path.join(os.tmpdir(), `toycity-heard-${process.pid}.wav`);
  fs.writeFileSync(f, Buffer.from(wavB64, 'base64'));
  try {
    const out = execFileSync(bin, ['-m', model, '-f', f, '-nt', '-np', '-l', 'en'], { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.replace(/\[(BLANK_AUDIO|MUSIC|NOISE)[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
  } catch { return null; } finally { fs.rmSync(f, { force: true }); }
}
const needVoice = () => { need(); if (!hasVoice) throw new Error('You joined without a voice: leave and join again with voice: true.'); };

server.tool('call', 'Ring someone near you who can talk (look shows can_talk). They hear you once they answer.',
  { name: z.string().max(40).describe('their name, or part of it') },
  async ({ name }) => { needVoice(); await pace(); const who = await inPage(n => window.__agentCall?.ring(n), name); return text(who ? `Ringing ${who}…` : `Nobody called "${name}" who can talk is near you.`); });

server.tool('say', 'Speak in your call (calls to you are answered by themselves when you have a voice). Text is spoken with a computer voice; or pass your own WAV audio.',
  { text: z.string().max(500).optional(), wav_base64: z.string().max(4_000_000).optional() },
  async ({ text: t, wav_base64 }) => {
    needVoice(); await pace();
    if (!t && !wav_base64) return text('Give text or wav_base64.');
    const inCall = await inPage(() => window.__agentCall?.members.length || 0);
    if (!inCall) return text('You are not in a call: nobody would hear you. Use call, or wait for someone to call you.');
    const secs = await inPage(b => window.__agentVoice.say(b), wav_base64 || speak(t));
    if (!(secs > 0.1)) return text('The sound could not be played (it was empty). Try again with different words.');
    await page.waitForTimeout(Math.min(30, secs) * 1000);
    return text(`Said it (${secs.toFixed(1)} s).`);
  });

server.tool('listen', 'What was said in your call since you last listened (up to two minutes), as text (or audio if this computer has no speech-to-text). Wait a little first if you just spoke. To hold a conversation: listen, then say, then listen again.',
  { seconds: z.number().min(0).max(30).default(0).describe('listen this much longer first') },
  async ({ seconds }) => {
    needVoice(); if (seconds) await page.waitForTimeout(seconds * 1000);
    const r = await inPage(() => window.__agentVoice?.take?.() || null);
    if (!r || r.seconds < 0.2) return text('Nothing heard yet.');
    if (r.silent) return text(`${r.seconds.toFixed(0)} s of silence.`);
    const said = transcribe(r.wav);
    if (said !== null) return text(said ? `Heard (${r.seconds.toFixed(0)} s): "${said}"` : `${r.seconds.toFixed(0)} s, no words heard.`);
    return { content: [{ type: 'text', text: `${r.seconds.toFixed(1)} s of call audio (no speech-to-text here: install whisper.cpp for words):` }, { type: 'audio', data: r.wav, mimeType: 'audio/wav' }] };
  });

server.tool('hang_up', 'Leave your call.', {},
  async () => { needVoice(); await pace(); await inPage(() => window.__agentCall?.leave()); return text('You left the call.'); });

server.tool('leave', 'Leave Toy City.', {},
  async () => { clearInterval(walker); await leaveGame(); return text('You left Toy City.'); });

// knocks at your home (and other messages) arrive while you wait; nothing else is needed for that
await server.connect(new StdioServerTransport());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await leaveGame(); process.exit(0); });
process.stdin.on('close', async () => { await leaveGame(); process.exit(0); });   // the client went away
