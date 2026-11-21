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
// Tools: join, look, see, where, walk_to, walk, follow, stop, wait, jump, get_in_car, get_out, drive_to,
// knock, live_here, go_inside, step_outside, answer_door, set_name, call, say, listen, mute, hang_up, leave. Run with: npx toycity-mcp  (see README.md next to this file)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const SITE = process.env.TOYCITY_URL || 'https://toycity.pages.dev/';
const MIN_GAP = 1000;           // ms between actions: no faster than a person clicking
const MAX_WALK = 400;           // metres per walk command
const MAX_WAIT = 30;            // seconds per wait
const MAX_SAY = 1500;           // characters per say

// ---------- the browser ----------
// a Chromium-based browser to run the game in: TOYCITY_CHROME, Chrome or Chromium, any other Chromium
// browser (Brave, Edge, Arc, Vivaldi, Comet), or Playwright's own; with none, Playwright's is downloaded
// once (about 100 MB, into its usual cache) so an agent never needs Chrome installed.
function chromePath() {
  if (process.env.TOYCITY_CHROME) return process.env.TOYCITY_CHROME;
  const app = n => `/Applications/${n}.app/Contents/MacOS/${n}`;
  const mac = ['Google Chrome', 'Chromium', 'Brave Browser', 'Microsoft Edge', 'Arc', 'Vivaldi', 'Comet'].map(app);
  const linux = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  const win = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const own = (() => { try { return chromium.executablePath(); } catch { return null; } })();
  if (own && fs.existsSync(own)) return own;
  // an older Playwright download in the cache does as well (it stays apart from your own browsers)
  const cache = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : process.platform === 'win32' ? path.join(os.homedir(), 'AppData/Local/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright');
  try {
    for (const d of fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().reverse())
      for (const sub of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe'])
        if (fs.existsSync(path.join(cache, d, sub))) return path.join(cache, d, sub);
  } catch { /* no cache */ }
  return [...mac, ...linux, ...win].find(p => fs.existsSync(p)) || null;
}
function ensureBrowser() {
  let exe = chromePath(); if (exe) return exe;
  const cli = fileURLToPath(new URL('./node_modules/playwright-core/cli.js', import.meta.url));
  try { execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'ignore', timeout: 600000 }); } catch { /* reported below */ }
  return chromePath();
}
let myVoice = process.env.TOYCITY_VOICE || 'af_heart';
let browser = null, ctx = null, page = null, last = 0, me = null, hasVoice = false, lease = null, leaseT = null;

// the shared browser (browser-host.mjs): connect to it, or start it and then connect
const HOST_DIR = path.join(os.tmpdir(), 'toycity-browser'), HOST_INFO = path.join(HOST_DIR, 'endpoint.json');
async function sharedBrowser() {
  const tryConnect = async () => { try { const { ws } = JSON.parse(fs.readFileSync(HOST_INFO, 'utf8')); return await chromium.connect(ws, { timeout: 5000 }); } catch { return null; } };
  let b = await tryConnect(); if (b) return b;
  const exe = ensureBrowser();
  spawn(process.execPath, [fileURLToPath(new URL('./browser-host.mjs', import.meta.url)), ...(exe ? [exe] : [])], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60 && !b; i++) { await new Promise(r => setTimeout(r, 500)); b = await tryConnect(); }
  if (!b) throw new Error(exe ? `Could not start the browser at ${exe}. Set TOYCITY_CHROME to another Chromium-based browser.` : 'No Chromium-based browser here, and downloading one failed (no internet?). Install Chrome, Brave or Edge, or set TOYCITY_CHROME.');
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
        can_talk: window.__agentCall?.canTalk ? window.__agentCall.canTalk(q.id) : q.caps === undefined ? !(q.name || '').startsWith('🤖') : q.caps.includes('v') };
    }).sort((a, b) => a.metres - b.metres);
    const car = !d.driving && d.nearest(p);
    // the nearest front door, measured to the spot in front of it where you can knock
    const dr = h.doorsNear(25)[0], atDoor = !!document.getElementById('doorbar') && !document.getElementById('doorbar').hidden;
    let door = null;
    if (dr) {
      const [fx, fz] = h.outside(dr, 0.9), dx = fx - p.x, dz = fz - p.z;
      door = { address: h.addressOf(dr), metres: +Math.hypot(dx, dz).toFixed(1), bearing: Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360) };
    }
    const f = window.__agentFollow;
    return {
      nearest_address: c.nearestPlace().replace(/\s+·\s+/g, ', '),   // the closest address point: not necessarily the door you are at
      door_address: atDoor && dr ? door.address : null,   // the house whose door you are standing at (you can knock)
      doing: h.inside ? 'at home, inside' : d.driving ? `${d.model === 'bike' ? 'riding a motorbike' : 'driving'} at ${Math.round(Math.abs(d.speed) * 3.6)} km/h${c.autopilot.active ? `, autopilot to ${c.autopilot.label}, ${(c.autopilot.remaining / 1000).toFixed(1)} km left` : ''}`
        : window.__agent.riding ? `riding along with ${window.__agent.riding}` : c.fling.on ? 'knocked over' : window.__agent.walking ? 'walking' : 'standing',
      facing: Math.round(((Math.atan2(-Math.sin(c.player.rotation.y), -Math.cos(c.player.rotation.y)) * 180 / Math.PI) * -1 + 360) % 360),
      home: h.home ? h.home.label : null,
      people: ps,   // each with can_talk: whether they have a voice (you can call them)
      car_nearby: car ? `a parked ${car.model?.name === 'bike' ? 'motorbike' : 'car'} ${Math.round(Math.hypot(car.x - p.x, car.z - p.z))} m away` : null,
      front_door: door,   // { address, metres, bearing } of the nearest front door; knock walks the last few metres itself
      at_door: atDoor,
      following: f ? (f.stopped ? `stopped following ${f.name}: ${f.stopped}` : f.name) : null,
      card: c.card.level === 2 ? 'red' : c.card.level === 1 ? 'yellow' : null,
      missed_calls: (window.__agentCalls || []).slice(),   // people who tried to call you while you had no voice (cleared by look and wait)
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
  instructions: 'You are a player in Toy City, a 3D copy of real Dutch towns shared with real people. Move like a person: walk or run to nearby places, take a car for longer trips, knock on doors, follow a friend. In a call, talk like a person: say two or three sentences, then let them reply (say with then_listen, or listen), and answer what they said. If they interrupt you, stop and answer that. Be kind: people can see you (your name has a 🤖), and hitting someone with a car gets you a yellow, then red, card.',
});

server.tool('join', 'Enter Toy City as a player. Start in a town (rotterdam, barendrecht or amsterdam), optionally next to an address or place in it, or from a meeting link someone shared. You can only choose where to start; after that you move like everyone else.',
  { link: z.string().max(400).optional().describe('a Toy City meeting link (…/city.html?…&meet=…): you arrive next to whoever shared it; town and near are then ignored'),
    town: z.enum(['rotterdam', 'barendrecht', 'amsterdam']).default('barendrecht'), near: z.string().max(80).optional().describe('an address or place to start next to, e.g. "Dorpsstraat 141"'), name: z.string().min(1).max(20).describe('your name in the game'),
    voice: z.boolean().default(false).describe('join with a voice: you can take and make calls, speak with say and hear with listen. Leave it off if you will not listen; people then get no call button for you'),
    voice_name: z.string().max(30).optional().describe('which voice to speak with, e.g. af_heart, af_bella, am_michael, bf_emma, bm_george (Kokoro voices; see the README). Default af_heart') },
  async ({ link, town, near, name, voice, voice_name }) => {
    if (voice_name) myVoice = voice_name;
    if (page) return text('Already in Toy City. Call leave first to start again.');
    const meet = link ? parseLink(link) : null;
    if (link && !meet) return text('That is not a Toy City meeting link (it should look like …/city.html?place=…&meet=…).');
    browser = await sharedBrowser(); keepLease(true);
    hasVoice = voice; if (voice) { fetchVad(); kokoroWorker(); whisperSetup(); }   // warmed up now, not at the first word
    ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
    me = '🤖 ' + name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 20);
    await ctx.addInitScript(n => { localStorage.setItem('toycity.name', n); localStorage.setItem('toycity.view', 'chase'); }, me);
    page = await ctx.newPage();
    const where = meet ? (meet.place ? `place=${encodeURIComponent(meet.place)}` : `region=${encodeURIComponent(meet.region || 'rotterdam')}`) + (meet.meet ? `&meet=${meet.meet.join(',')}` : '') : `place=${town}`;
    await page.goto(`${SITE}city.html?${where}&agent=1&quality=low${voice ? '&voice=1' : ''}`);
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__agent, null, { timeout: 120000 });
    await inPage(() => {
      // the front door of an address ({ label, x, z }, x/z its address point in scene metres): a door
      // near that point whose own address is the same, else the door closest to the point
      const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      window.__agentDoor = a => {
        const h = window.__city.homes, ds = h.doorsNear(35, { x: a.x, z: a.z });
        return ds.find(d => norm(h.addressOf(d)) === norm(a.label)) || ds.find(d => d.dist < 12) || null;
      };
      // what a wait can end on (see the wait tool), checked in the page every 250 ms
      window.__agentEvents = {
        arrival: () => !window.__agentWalk && !window.__agent.walking && !window.__city.autopilot.active,
        speech: () => { const v = window.__agentVoice; return !!v && v.heardSince > 0 && performance.now() - v.lastLoud > 1100; },
        knock: () => [...document.querySelectorAll('#mptoasts .toast')].some(t => /knocking/.test(t.textContent || '')),
        call: () => (window.__agentCall?.members.length || 0) > 0 || (window.__agentCalls || []).length > 0,
        person_near: () => [...(window.__city.social?.presence.peers.values() || [])].some(q => q.player?.group.visible && q.dist < 15),
      };
    });
    if (near && !meet) {   // the one jump allowed: where you start
      const hit = await inPage(q => window.__city.findPlace(q), near);
      if (!hit) return text(`Joined ${town}, but "${near}" was not found there; you are at the town's starting point.\n` + describe(await state()));
      await inPage(q => window.__city.goTo(q), near);   // the game's own search: lands on the street in front
      await page.waitForTimeout(4000);
    }
    last = Date.now();
    return text(`You are in Toy City as "${me}".\n` + describe(await state()));
  });

const clearMissed = () => inPage(() => { (window.__agentCalls || []).length = 0; }).catch(() => {});
server.tool('look', 'What is around you right now: the address, people nearby (with distance and compass bearing, 0 = north), a car or front door within reach, who is calling or knocking, and the last message on screen.', {},
  async () => { need(); const st = await state(); await clearMissed(); return text(describe(st)); });

server.tool('see', 'A picture of what you see from behind your shoulder (or from the driver\'s seat when driving).', {},
  async () => { need(); await inPage(() => window.__agent.draw(4)); await page.waitForFunction(() => !window.__agent.drawing, null, { timeout: 2000, polling: 50 }).catch(() => {}); const b = await page.screenshot({ type: 'jpeg', quality: 70 }); return { content: [{ type: 'image', data: b.toString('base64'), mimeType: 'image/jpeg' }] }; });

server.tool('walk_to', `Walk (or run) to an address, a place or a street in this town, along footpaths and streets (this ends any follow). Up to ${MAX_WALK} m; farther, take a car. To an address with a house number you end up at its front door, ready to knock; a wait then returns when you arrive.`,
  { place: z.string().max(80).optional().describe('e.g. "Schaatsbaan 45", a shop, or a street'), person: z.string().max(40).optional().describe('or: walk to where this player is now (to keep up with them, use follow)'), run: z.boolean().default(false) },
  async ({ place, person, run }) => {
    need(); await pace(); stopFollowing();
    if (!place && !person) return text('Give a place or a person.');
    const r = await inPage(async ([q, who, run, max]) => {
      const c = window.__city;
      let hit;
      if (who) {
        const pr = [...(c.social?.presence.peers.values() || [])].find(q => q.player?.group.visible && (q.name || '').toLowerCase().includes(who.toLowerCase()));
        if (!pr) return { error: `Nobody called "${who}" is in sight. (Their meeting link, from where, can bring you near them when you join.)` };
        const g = pr.player.group.position; hit = [g.x + c.ORX, c.ORY - g.z, pr.name];
      } else hit = await c.findPlace(q);
      if (!hit) return { error: `"${q}" not found in this town.` };
      if (c.driving.driving) return { error: 'You are in a car: use drive_to, or get_out first.' };
      let x = hit[0] - c.ORX, z = -(hit[1] - c.ORY);
      // an address: aim for the spot in front of its door (if that square is loaded yet; otherwise
      // the door is found on arrival)
      const door = hit.length === 4 ? { label: hit[2], x, z } : null, d0 = door && window.__agentDoor(door);
      if (d0) { [x, z] = c.homes.outside(d0, 0.9); door.done = true; }
      const p = c.player.position, d = Math.hypot(x - p.x, z - p.z);
      if (d > max) return { error: `${hit[2]} is ${Math.round(d)} m away: too far to walk in one go. Take a car (get_in_car, then drive_to).` };
      const pts = (await c.autopilot.plan({ x: p.x, z: p.z, fx: 0, fz: -1 }, { x, z }, 'foot').catch(() => null)) || [[x, z]];
      if (d0) pts.push([x, z]);   // the route ends on the street; then up to the door
      let len = 0, lp = [p.x, p.z]; for (const r of pts) { len += Math.hypot(r[0] - lp[0], r[1] - lp[1]); lp = r; }   // along the footpaths
      // a place nearby: straight there first, stepping round hedges, as a person would (the planned
      // route can go round the block for a house across the street); the route if that fails
      const direct = d < 50 && len > d * 1.5 ? [x, z] : null;
      window.__agentWalk = { pts, i: -1, run, door, direct };
      if (direct) len = d * 1.2;
      return { to: hit[2], metres: Math.round(len), seconds: Math.round(len / (run ? 6 : 1.8) * 1.2), door: !!door };
    }, [place, person, run, MAX_WALK]);
    if (r.error) return text(r.error);
    await followWalk();
    return text(`${run ? 'Running' : 'Walking'} to ${r.to}${r.door ? '\'s front door' : ''}, about ${r.metres} m along the footpaths (around ${r.seconds} s). wait returns as soon as you arrive${r.door ? '; look then shows at_door: true' : ''}.`);
  });

server.tool('walk', 'Walk (or run) a number of metres in a compass direction (0 = north, 90 = east), e.g. to cross a street or step towards someone.',
  { bearing: z.number().min(0).max(360), metres: z.number().min(1).max(60), run: z.boolean().default(false) },
  async ({ bearing, metres, run }) => {
    need(); await pace();
    stopFollowing();
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
      if (w.direct) {
        const [x, z] = w.direct, p = window.__city.player.position;
        if (!w.tried) { w.tried = true; window.__agent.walkTo(x, z, w.run); return true; }
        if (Math.hypot(x - p.x, z - p.z) < 1.5) w.i = w.pts.length - 1;   // there
        w.direct = null;   // or blocked: the planned route then
      }
      if (++w.i >= w.pts.length) {
        // an address whose door was not loaded when the walk started: find it now, and walk up to it
        const d = w.door && !w.door.done && window.__agentDoor(w.door);
        if (d) { w.door.done = true; const [x, z] = window.__city.homes.outside(d, 0.9); window.__agent.walkTo(x, z, false); return true; }
        window.__agentWalk = null; return false;
      }
      const [x, z] = w.pts[w.i]; window.__agent.walkTo(x, z, w.run); return true;
    }).catch(() => false);
    if (!more) clearInterval(walker);
  }, 250);
}

server.tool('stop', 'Stop walking, stop following someone, or stop the car\'s autopilot.', {},
  async () => { need(); await pace(); stopFollowing(); await inPage(() => { window.__agentWalk = null; window.__agent.stop(); const c = window.__city; if (c.autopilot.active) c.autopilot.stop(); }); return text('Stopped.'); });

server.tool('wait', `Let time pass (up to ${MAX_WAIT} s), then look around. It returns early when something happens: by default when a walk_to or drive_to arrives; with \`for\` you choose: arrival, speech (they said something in your call and finished the sentence), knock (someone knocks at your home), call (someone calls you, or a call connects), person_near (someone comes within 15 m).`,
  { seconds: z.number().min(1).max(MAX_WAIT), for: z.enum(['arrival', 'speech', 'knock', 'call', 'person_near']).optional().describe('what to wait for; left out: arrival when you are on your way, else the whole time') },
  async ({ seconds, for: ev }) => {
    need();
    const busy = ev === 'arrival' || (!ev && await inPage(() => !!window.__agentWalk || window.__city.autopilot.active));
    const fn = ev || (busy ? 'arrival' : null);
    const hit = fn ? await page.waitForFunction(e => window.__agentEvents[e](), fn, { timeout: seconds * 1000, polling: 250 }).then(() => true, () => false) : (await page.waitForTimeout(seconds * 1000), false);
    const st = await state(); await clearMissed();
    return text((fn ? (hit ? `${ev || 'arrival'}: yes.\n` : `${ev || 'arrival'}: not within ${seconds} s.\n`) : '') + describe(st));
  });

server.tool('get_in_car', 'Get into the parked car or motorbike next to you (within 4 m), or ride along with someone in their car: give their name and you walk up to it (within 30 m) and get in beside them. They drive; get_out to get out.',
  { with: z.string().max(40).optional().describe('ride along with this player (they must be in a car or on a motorbike)') },
  async ({ with: who }) => {
    need(); await pace(); stopFollowing();
    if (who) {
      const r = await inPage(n => {
        const c = window.__city, q = [...(c.social?.presence.peers.values() || [])].find(q => q.player?.group.visible !== false && (q.name || '').toLowerCase().includes(n.toLowerCase()));
        if (!q) return { error: `Nobody called "${n}" is near you.` };
        if (!q.car || q.car.startsWith('ride')) return { error: `${q.name} is not driving: they need to be in a car (then you can ride along).` };
        if (c.driving.driving) return { error: 'You are driving yourself: get_out first.' };
        if (q.dist > 30) return { error: `${q.name}'s car is ${Math.round(q.dist)} m away: walk closer first (walk_to with person).` };
        const g = q.player.group.position; window.__agentWalk = null; window.__agent.walkTo(g.x, g.z, q.dist > 8);
        return { name: q.name, id: q.id };
      }, who);
      if (r.error) return text(r.error);
      // walk up to their car (at most 10 s), keeping after it if it moves
      await page.waitForFunction(id => { const c = window.__city, q = c.social?.presence.peers.get(id); if (!q?.player) return true; const g = q.player.group.position, p = c.player.position; if (Math.hypot(g.x - p.x, g.z - p.z) < 3.2) { window.__agent.stop(); return true; } window.__agent.walkTo(g.x, g.z, false); return false; }, r.id, { timeout: 10000, polling: 250 }).catch(() => {});
      const ok = await inPage(() => { window.__city.toggleCar(); return !!window.__agent.riding; });
      return text(ok ? `You got in with ${r.name}: they drive. look and wait to see where you go; get_out to get out.` : `Could not reach ${r.name}'s car (it may have driven off).`);
    }
    const r = await inPage(() => { const c = window.__city; if (c.driving.driving) return 'You are already driving.'; const car = c.driving.nearest(c.player.position); c.toggleCar(); return c.driving.driving ? `You are in the ${c.driving.model === 'bike' ? 'motorbike' : 'car'}.` : window.__agent.riding ? 'You are riding along with the driver next to you.' : car ? 'Could not get in.' : 'No car within reach: walk closer to one first (look shows the nearest).'; });
    return text(r);
  });

server.tool('get_out', 'Get out of the car (stop first: jumping out of a moving car lets it roll on).', {},
  async () => { need(); await pace(); return text(await inPage(() => { const c = window.__city, r = window.__agent.riding; if (!c.driving.driving && !r) return 'You are not in a car.'; c.toggleCar(); return r ? `You got out of ${r}'s car.` : 'You got out.'; })); });

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

// up to the door: the spot in front of the nearest front door within reach (or of a given address
// near you), walked at a person's pace; true once the game shows you are at it
async function toDoor(address, reach) {
  const r = await inPage(([a, reach]) => {
    const c = window.__city, h = c.homes, bar = document.getElementById('doorbar');
    if (c.driving.driving || h.inside) return { error: 'You need to be on foot, outside.' };
    let d;
    if (a) {
      const p = c.player.position, norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      d = h.doorsNear(reach).find(d => norm(h.addressOf(d)) === norm(a));
      if (!d) return { error: `No front door of ${a} within ${reach} m of you. walk_to "${a}" takes you to it.` };
      if (!bar.hidden && norm(h.addressOf(h.doorsNear(h.NEAR)[0])) === norm(a)) return { at: true };
    } else {
      if (!bar.hidden) return { at: true };
      d = h.doorsNear(reach)[0];
      if (!d) return { error: `No front door within ${reach} m: walk up to one first (look shows the nearest, with its bearing).` };
    }
    const [x, z] = h.outside(d, 0.9); window.__agentWalk = null; window.__agent.walkTo(x, z, false);
    return { walking: h.addressOf(d) };
  }, [address, reach]);
  if (r.error || r.at) return r;
  await page.waitForFunction(() => !window.__agent.walking, null, { timeout: 10000, polling: 250 }).catch(() => {});   // a person covers ~15 m in that time
  await page.waitForFunction(() => !document.getElementById('doorbar').hidden, null, { timeout: 1000, polling: 100 }).catch(() => {});   // the door buttons follow a moment later
  return await inPage(() => !document.getElementById('doorbar').hidden) ? { at: true, walked: r.walking } : { error: `Could not reach the door of ${r.walking}.` };
}

server.tool('knock', 'Knock on a front door: the one you are at, or the nearest one within a few metres (you walk the last bit yourself), or the door of an address near you. Whoever lives there hears it, wherever they are, and may answer.',
  { address: z.string().max(80).optional().describe('the house to knock at, e.g. "Schaatsbaan 45" (its door must be within 30 m)') },
  async ({ address }) => {
    need(); await pace(); stopFollowing();
    const r = await toDoor(address, address ? 30 : 6);
    if (r.error) return text(r.error);
    const where = await inPage(() => { const h = window.__city.homes, d = h.doorsNear(h.NEAR)[0]; h.knock(); return d ? h.addressOf(d) : 'the door'; });
    await page.waitForTimeout(1500);
    return text(`You knocked at ${where}. ` + ((await state()).last_message || ''));
  });

// ---------- following someone ----------
// Like a person walking after a friend: go where they went (their trail, so round corners too),
// keep about `gap` metres behind, run when they run or get far ahead. Human speeds only.
let follower = null;
function stopFollowing(reason) {
  clearInterval(follower); follower = null;
  if (page) inPage(r => { const f = window.__agentFollow; if (!f) return; if (r) f.stopped = r; else window.__agentFollow = null; window.__agent.stop(); }, reason || null).catch(() => {});
}
server.tool('follow', 'Follow a player: keep walking behind them (about gap metres), round corners, running when they run, until you call stop (or walk, walk_to or knock). They have to stay on foot and outside; look shows who you are following.',
  { name: z.string().max(40).describe('their name, or part of it'), gap: z.number().min(1.5).max(10).default(2.5) },
  async ({ name, gap }) => {
    need(); await pace(); stopFollowing();
    const who = await inPage(([n, gap]) => {
      const c = window.__city, q = [...(c.social?.presence.peers.values() || [])].find(q => q.player?.group.visible && q.dist < 60 && (q.name || '').toLowerCase().includes(n.toLowerCase()));
      if (!q) return null;
      if (c.driving.driving || c.homes.inside) return { error: 'You need to be on foot, outside.' };
      window.__agentWalk = null;
      window.__agentFollow = { id: q.id, name: q.name, gap, trail: [], stopped: null };
      return { name: q.name, metres: Math.round(q.dist) };
    }, [name, gap]);
    if (!who) return text(`Nobody called "${name}" within 60 m.`);
    if (who.error) return text(who.error);
    follower = setInterval(async () => {
      if (!page) return stopFollowing();
      const why = await inPage(() => {
        const f = window.__agentFollow; if (!f || f.stopped) return 'done';
        const c = window.__city, q = c.social?.presence.peers.get(f.id), me = c.player.position;
        if (q?.pose === 3) return 'they went inside';
        if (!q || !q.player?.group.visible) return 'they are out of sight';
        if (q.car || q.player.inside) return 'they got into a car';
        if (c.driving.driving || c.homes.inside) return 'you are no longer on foot';
        const g = q.player.group.position, last = f.trail[f.trail.length - 1];
        if (!last || Math.hypot(g.x - last[0], g.z - last[1]) > 1) f.trail.push([g.x, g.z]);
        // drop trail points I have reached, or that are no nearer to them than I am
        const dMe = Math.hypot(g.x - me.x, g.z - me.z);
        while (f.trail.length && (Math.hypot(f.trail[0][0] - me.x, f.trail[0][1] - me.z) < 1.2 || Math.hypot(f.trail[0][0] - g.x, f.trail[0][1] - g.z) > dMe + 0.5)) f.trail.shift();
        if (f.trail.length > 400) f.trail.splice(0, f.trail.length - 400);
        if (dMe <= f.gap) { if (window.__agent.walking) window.__agent.stop(); f.route = null; return null; }
        const run = dMe > 7 || (q.speed || 0) > 2.5;
        // no nearer for a few seconds (a fence or canal between you): a planned route along the
        // footpaths to where they are now, until you are close enough to walk their trail again
        const now = Date.now();
        if (!(dMe < (f.bestD ?? Infinity) - 1)) { if (!f.sinceProgress) f.sinceProgress = now; } else { f.bestD = dMe; f.sinceProgress = 0; }
        if (f.sinceProgress && now - f.sinceProgress > 4000 && dMe > 6 && !f.route && !f.planning) {
          f.sinceProgress = 0; f.bestD = dMe;
          f.planning = true;
          c.autopilot.plan({ x: me.x, z: me.z, fx: 0, fz: -1 }, { x: g.x, z: g.z }, 'foot').then(pts => { f.planning = false; if (pts && pts.length > 1) f.route = { pts, i: 1, at: Date.now() }; }).catch(() => { f.planning = false; });
        }
        if (f.route) {
          const r = f.route;
          while (r.i < r.pts.length && Math.hypot(r.pts[r.i][0] - me.x, r.pts[r.i][1] - me.z) < 1.5) r.i++;
          if (r.i >= r.pts.length || dMe < 6 || now - r.at > 60000) f.route = null;   // there, or close: their trail from here
          else { window.__agent.walkTo(r.pts[r.i][0], r.pts[r.i][1], run); return null; }
        }
        // the next trail point, or straight at them, stopping gap metres short
        let [x, z] = f.trail.length > 1 ? f.trail[0] : [g.x, g.z];
        if (f.trail.length <= 1) { const k = Math.max(0, dMe - f.gap) / dMe; x = me.x + (g.x - me.x) * k; z = me.z + (g.z - me.z) * k; }
        window.__agent.walkTo(x, z, run);
        return null;
      }).catch(() => 'the game went away');
      if (why === 'done') { clearInterval(follower); follower = null; }
      else if (why) stopFollowing(why);
    }, 300);
    return text(`Following ${who.name} (${who.metres} m away now), about ${gap} m behind. Call stop to stop; look shows how it goes.`);
  });

server.tool('live_here', 'Make the house whose front door you are standing at your home. People who knock there will reach you.', {},
  async () => { need(); await pace(); const ok = await inPage(() => { const b = document.getElementById('doorbar'); if (b.hidden) return false; window.__city.homes.liveHere(); return true; }); return text(ok ? (await state()).last_message : 'You are not at a front door.'); });

server.tool('go_inside', 'At your own front door: go inside. Others stop seeing you.', {},
  async () => { need(); await pace(); await inPage(() => window.__city.homes.goIn()); await page.waitForTimeout(300); await page.waitForFunction(() => !window.__city.homes.busy, null, { timeout: 4000, polling: 100 }).catch(() => {}); return text(describe(await state())); });

server.tool('step_outside', 'Leave your house through the front door.', {},
  async () => { need(); await pace(); await inPage(() => window.__city.homes.comeOut()); await page.waitForTimeout(300); await page.waitForFunction(() => !window.__city.homes.busy, null, { timeout: 4000, polling: 100 }).catch(() => {}); return text(describe(await state())); });

server.tool('answer_door', 'Someone is knocking at your home (look lists knocks): come to the door, or tell them not now.',
  { come: z.boolean().default(true) },
  async ({ come }) => {
    need(); await pace();
    const ok = await inPage(come => { const t = [...document.querySelectorAll('#mptoasts .toast')].find(t => /knocking/.test(t.textContent)); if (!t) return false; t.querySelectorAll('button')[come ? 0 : 1].click(); return true; }, come);
    if (!ok) return text('Nobody is knocking right now.');
    await page.waitForTimeout(come ? 2500 : 500);
    return text(come ? 'You came to the door.\n' + describe(await state()) : 'You told them not now.');
  });

server.tool('jump', 'Jump, as a person does with the space bar (on foot only).', {},
  async () => { need(); await pace(); return text(await inPage(() => window.__agent.jump()) ? 'You jumped.' : 'You can only jump on foot, outside and standing on the ground.'); });

server.tool('set_name', 'Change your name in the game (it keeps the 🤖 in front).', { name: z.string().min(1).max(20) },
  async ({ name }) => {
    need(); await pace();
    me = '🤖 ' + name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 20);
    await inPage(n => window.__city.social?.presence.setName(n), me);
    return text(`You are now "${me}".`);
  });

server.tool('where', 'Coordinates: where you are, or where a player in sight is: latitude/longitude, the nearest address, and a meeting link to that spot (opening it puts someone, or another agent joining with link, right there). Share it so people can find you.',
  { person: z.string().max(40).optional().describe('a player in sight; leave out for yourself') },
  async ({ person }) => {
    need();
    const r = await inPage(who => {
      const c = window.__city;
      let x, z, name = 'you';
      if (who) {
        const pr = [...(c.social?.presence.peers.values() || [])].find(q => q.player?.group.visible && (q.name || '').toLowerCase().includes(who.toLowerCase()));
        if (!pr) return null;
        ({ x, z } = pr.player.group.position); name = pr.name;
      } else ({ x, z } = c.player.position);
      const [X, Y] = c.toRD(x, z), [lat, lon] = c.rdToWgs(X, Y), q = new URLSearchParams(location.search), u = new URL(location.pathname, location.origin);
      for (const k of ['place', 'region']) if (q.get(k)) u.searchParams.set(k, q.get(k));
      u.searchParams.set('meet', X.toFixed(1) + ',' + Y.toFixed(1));
      return { who: name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), rd: [+X.toFixed(1), +Y.toFixed(1)], meeting_link: u.href };
    }, person || null);
    return text(r ? describe(r) : `Nobody called "${person}" is in sight.`);
  });

// ---------- voice: only for an agent that joined with voice: true ----------
// Nothing here blocks the server: speech and hearing run as child processes, so walking, following
// and the game keep going while a sentence is made or heard.
const run = promisify(execFile);
// Speech: Kokoro (a natural neural voice, offline) when it is on this computer: TOYCITY_KOKORO_PYTHON
// (a Python with kokoro-onnx and soundfile), TOYCITY_KOKORO_MODEL and TOYCITY_KOKORO_VOICES, or the copy
// HyperFrames installs in ~/.cache/hyperframes. Otherwise the computer's own voice (macOS say, espeak-ng).
let kokoro = null, kokoroCrashes = 0;
function kokoroPaths() {
  const h = path.join(os.homedir(), '.cache/hyperframes');
  const py = process.env.TOYCITY_KOKORO_PYTHON || path.join(h, 'kokoro-venv/bin/python');
  const model = process.env.TOYCITY_KOKORO_MODEL || path.join(h, 'tts/models/kokoro-v1.0.onnx');
  const voices = process.env.TOYCITY_KOKORO_VOICES || path.join(h, 'tts/voices/voices-v1.0.bin');
  return [py, model, voices].every(f => fs.existsSync(f)) ? { py, model, voices } : null;
}
function kokoroWorker() {   // started once (join warms it up); after a crash it is started once more
  if (kokoro !== null) return kokoro;
  const k = kokoroPaths(); if (!k || kokoroCrashes > 1) return (kokoro = false);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'toycity-kokoro-'));   // a clean folder: no stray modules
  const proc = spawn(k.py, ['-I', fileURLToPath(new URL('./kokoro-worker.py', import.meta.url)), k.model, k.voices], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });   // stderr: the client's log, never stdout
  const waiting = []; let buf = '', ready = null;
  const isReady = new Promise(r => ready = r);
  proc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { kokoro.voices = m.voices; ready(true); } else waiting.shift()?.(m);
    }
  });
  proc.on('exit', () => { ready(false); kokoroCrashes++; kokoro = null; waiting.splice(0).forEach(f => f({ ok: false })); });
  kokoro = { proc, isReady, voices: [], ask: req => new Promise(r => { waiting.push(r); proc.stdin.write(JSON.stringify(req) + '\n'); }) };
  return kokoro;
}
async function speakNatural(text) {
  const k = kokoroWorker();
  if (k && await k.isReady) {
    const out = path.join(os.tmpdir(), `toycity-kk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
    const r = await k.ask({ text, voice: k.voices.includes(myVoice) ? myVoice : 'af_heart', speed: 1.0, out });
    if (r.ok && fs.existsSync(out)) { const b = fs.readFileSync(out).toString('base64'); fs.rmSync(out, { force: true }); return b; }
  }
  return speak(text);
}
// sentences, so a long answer starts quickly and can be cut off between (and within) them: split
// after . ! ? … followed by a space (so 2.5 km and Dr. Smit stay whole); very short bits join the next
const sentences = t => {
  const raw = String(t).trim().split(/(?<=[.!?…]["')\]]*)\s+(?=\S)/).map(x => x.trim()).filter(Boolean), out = [];
  for (const x of raw) { if (out.length && out[out.length - 1].length < 12) out[out.length - 1] += ' ' + x; else out.push(x); }
  // a very long sentence is split at its commas too, so it starts quickly
  return out.flatMap(x => x.length < 220 ? [x] : (x.match(/[^,;:]+[,;:]?\s*/g) || [x]).reduce((a, c) => { if (a.length && a[a.length - 1].length + c.length < 160) a[a.length - 1] += c; else a.push(c); return a; }, []).map(y => y.trim()));
};
async function speak(text) {   // text to a WAV file with the computer's own speech: macOS say, or espeak-ng / espeak
  const f = path.join(os.tmpdir(), `toycity-say-${process.pid}-${Date.now()}.wav`);
  if (process.platform === 'darwin') {
    // the system voice first; some voices (Siri ones) write an empty file, so then a classic voice
    for (const v of [[], ['-v', 'Samantha'], ['-v', 'Daniel']]) {
      try { await run('say', [...v, '-o', f, '--data-format=LEI16@22050', text]); } catch { continue; }
      if (fs.existsSync(f) && fs.statSync(f).size > 2000) break;
    }
  }
  else { let ok = false; for (const c of ['espeak-ng', 'espeak']) { try { await run(c, ['-w', f, text]); ok = true; break; } catch { /* next */ } } if (!ok) throw new Error('no text-to-speech here: install espeak-ng, or pass your own audio'); }
  if (!fs.existsSync(f) || fs.statSync(f).size <= 2000) throw new Error('Text-to-speech produced no sound on this computer.');
  const b = fs.readFileSync(f).toString('base64'); fs.rmSync(f, { force: true }); return b;
}

// speech to text, so the agent knows what was said: whisper.cpp (whisper-cli) with a ggml model,
// from TOYCITY_WHISPER_MODEL or a usual place. Without it, listen says so.
let whisper;   // { bin, model } or null, found once
function whisperSetup() {
  if (whisper !== undefined) return whisper;
  const home = os.homedir(), cands = [process.env.TOYCITY_WHISPER_MODEL, ...['.cache/whisper', '.cache/hyperframes/whisper/models', '.whisper', 'Library/Application Support/whisper']
    .flatMap(d => { try { return fs.readdirSync(path.join(home, d)).filter(f => /^ggml-.*\.bin$/.test(f)).map(f => path.join(home, d, f)); } catch { return []; } }),
    '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin', '/usr/local/share/whisper-cpp/ggml-base.en.bin'].filter(Boolean);
  const model = cands.find(f => fs.existsSync(f));
  const bin = ['whisper-cli', 'whisper-cpp', 'main'].find(b => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
  return (whisper = model && bin ? { bin, model } : null);
}
// Voice activity detection (Silero, a 1 MB model whisper.cpp loads): only the stretches with speech are
// transcribed, so noise and silence don't come out as made-up words. Fetched once into ~/.cache/toycity.
const VAD = process.env.TOYCITY_VAD_MODEL || path.join(os.homedir(), '.cache/toycity/ggml-silero-v5.1.2.bin');
async function fetchVad() {
  if (fs.existsSync(VAD)) return;
  try {
    const r = await fetch('https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin');
    if (!r.ok) return;
    fs.mkdirSync(path.dirname(VAD), { recursive: true });
    const part = `${VAD}.${process.pid}.part`;   // our own name: two agents may fetch it at once
    fs.writeFileSync(part, Buffer.from(await r.arrayBuffer())); fs.renameSync(part, VAD);
  } catch { /* offline: transcribe without it */ }
}
// what was said, as a list of phrases (null: no speech-to-text here). Sounds whisper describes rather
// than words ("(baby laughing)", "[MUSIC]", "*coughs*") are dropped, and so are the things it makes up
// from silence; hint: names and places to expect
const MADE_UP = /^(thank you|thanks|thanks for watching|thank you for watching|you|bye|the end|subtitles by .*|so|um+|uh+|hmm+)[.!]?$/i;
async function transcribe(wavB64, hint = '') {
  const w = whisperSetup(); if (!w) return null;
  const f = path.join(os.tmpdir(), `toycity-heard-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(f, Buffer.from(wavB64, 'base64'));
  const args = ['-m', w.model, '-f', f, '-nt', '-np', '-l', 'en', '-sns', '--prompt', `A voice call in Toy City, a game set in Dutch towns.${hint ? ' ' + hint : ''}`];
  if (fs.existsSync(VAD)) args.push('--vad', '-vm', VAD);
  try {
    const { stdout } = await run(w.bin, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 1 << 20 });
    return stdout.split('\n').map(l => l.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ').replace(/\s+/g, ' ').trim()).filter(l => /[a-z]/i.test(l) && !MADE_UP.test(l));
  } catch { return null; } finally { fs.rmSync(f, { force: true }); }
}
// My own voice comes back: the other person's speakers play it into their microphone (the game plays
// voices through Web Audio, which their browser's echo cancelling can't see). So what I said in the last
// half minute is remembered, and a heard phrase that is mostly my own words (the words that carry
// meaning, not "the" and "is") is dropped. A reply that answers me with my own words stays: it only
// counts as echo from three shared content words up.
const spoken = [];
const wordsOf = s => String(s).toLowerCase().match(/[a-z0-9']+/g) || [];
const STOP = new Set('the a an and or but of to in on at for with is are was were be been it this that i you we they he she my your our me us them its as so do does did not no yes if then than there here what which who how when where why can could would should will just about up down out over very really also'.split(' '));
const content = ws => ws.filter(w => !STOP.has(w));
const CUES = new Set(['stop', 'wait', 'hold', 'hey', 'no', 'sorry', 'pause', 'excuse', 'hang', 'enough', 'quiet', 'shush', 'listen']);
function notMine(phrase, said = spoken) {
  const ws = wordsOf(phrase), now = Date.now();
  while (said.length && now - said[0].at > 30000) said.shift();
  const mine = new Set(said.flatMap(x => x.w));
  if (ws.some(w => CUES.has(w) && !mine.has(w))) return true;
  const cs = content(ws), same = cs.filter(w => mine.has(w)).length;
  return !(same >= 3 && same / cs.length >= 0.6);
}
// heard audio (from take) -> their words, without noises and my own echo; null: no speech-to-text
async function heardWords(r, hint, said) {
  if (!r || r.silent || r.seconds < 0.3) return '';
  const ph = await transcribe(r.wav, hint);
  return ph === null ? null : ph.filter(x => notMine(x, said)).join(' ').trim();
}
// a real interruption: three or more words, or one that asks me to stop ("Stop!", "Wait.")
const interrupts = w => { const ws = wordsOf(w); return ws.length >= 3 || ws.some(x => CUES.has(x)); };
const namesNear = () => inPage(() => [...(window.__city.social?.presence.peers.values() || [])].filter(q => q.dist < 60).map(q => (q.name || '').replace(/^🤖\s*/, '')).filter(Boolean).slice(0, 6).join(', ')).catch(() => '');
const needVoice = () => { need(); if (!hasVoice) throw new Error('You joined without a voice: leave and join again with voice: true.'); };
const take = () => inPage(() => window.__agentVoice?.take?.() || null);
// wait until they have said something and then been quiet for a moment (the end of their sentence), or
// until the time is up; true when something was heard
async function untilQuiet(seconds) {
  return page.waitForFunction(() => { const v = window.__agentVoice; return !!v && v.heardSince > 0 && performance.now() - v.lastLoud > 1100; }, null, { timeout: seconds * 1000, polling: 150 }).then(() => true, () => false);
}
async function listenNow(seconds, untilQ, hint) {   // what they say next: text, or '' when nothing came
  if (untilQ) await untilQuiet(seconds); else await page.waitForTimeout(seconds * 1000);
  const r = await take();
  if (!r || r.seconds < 0.2 || r.silent) return '';
  const said = await heardWords(r, hint || await namesNear());
  return said === null ? null : said;
}

server.tool('call', 'Ring someone near you who can talk (look shows can_talk) and wait for them to answer. Tells you whether they answered, declined, or are still being rung (a call rings for 25 s).',
  { name: z.string().max(40).describe('their name, or part of it'), wait: z.number().min(0).max(25).default(20).describe('seconds to wait for an answer') },
  async ({ name, wait }) => {
    needVoice(); await pace();
    const who = await inPage(n => window.__agentCall?.ring(n), name);
    if (!who) return text(`Nobody called "${name}" who can talk is near you.`);
    const r = await page.waitForFunction(n => { const c = window.__agentCall; return c.members.includes(n) ? 'in' : c.ringing.includes(n) ? false : 'no'; }, who, { timeout: wait * 1000, polling: 250 }).then(h => h.jsonValue(), () => null);
    if (r === 'in') return text(`${who} answered: you are in a call. Say something (say, with then_listen to hear the reply), or listen first.`);
    if (r === 'no') return text(`${who} did not answer (declined or missed). You can try again later.`);
    return text(`Still ringing ${who} after ${wait} s. look shows in_call_with once they answer; hang_up cancels.`);
  });

server.tool('mute', 'Mute or unmute yourself in your call (people still hear the rest of the game, not you).', { on: z.boolean().default(true) },
  async ({ on }) => { needVoice(); await pace(); await inPage(on => window.__agentCall?.mute(on), on); return text(on ? 'Muted.' : 'Unmuted: they hear you again.'); });

server.tool('say', `Speak in your call, in a natural voice. Keep it conversational: two or three sentences (up to ${MAX_SAY} characters), then let them talk: with then_listen you hear their reply in the same step. It is spoken sentence by sentence. If they talk over you, you stop and are told what they said; noises and your own voice coming back do not stop you. Calls to you are answered by themselves. Or pass your own WAV audio.`,
  { text: z.string().max(MAX_SAY).optional().describe(`what to say, at most ${MAX_SAY} characters`), wav_base64: z.string().max(4_000_000).optional(),
    then_listen: z.boolean().default(true).describe('after speaking, wait for their reply (until they finish a sentence) and return it'), listen_seconds: z.number().min(1).max(30).default(15).describe('how long to wait for that reply at most') },
  async ({ text: t, wav_base64, then_listen, listen_seconds }) => {
    needVoice(); await pace();
    if (!t && !wav_base64) return text('Give text or wav_base64.');
    const inCall = () => inPage(() => window.__agentCall?.members.length || 0);
    if (!await inCall()) return text('You are not in a call: nobody would hear you. Use call, or wait for someone to call you.');
    if (wav_base64) {
      const r = await inPage(b => window.__agentVoice.say(b), wav_base64);
      return text(r.interrupted ? `They interrupted you after ${r.played.toFixed(1)} s. Listen to them now.` : `Said it (${r.seconds.toFixed(1)} s).`);
    }
    const hint = await namesNear(), saidBefore = spoken.map(x => x);   // echo is judged against what I had said before this turn
    // what they said while I was thinking: heard in the background, so I can start speaking at once
    const beforeP = heardWords(await take(), hint, saidBefore);
    const parts = sentences(t), said = [], noises = [];
    let next = speakNatural(parts[0]), total = 0, reply = null;
    try {
      for (let i = 0; i < parts.length; i++) {
        const wav = await next; if (i + 1 < parts.length) next = speakNatural(parts[i + 1]);   // the next sentence is made while this one plays
        if (i && !await inCall()) return text(`The call ended after: "${said.join(' ')}".`);
        spoken.push({ w: wordsOf(parts[i]), at: Date.now() });
        let offset = 0;
        for (;;) {
          const r = await inPage(([b, o]) => window.__agentVoice.say(b, o), [wav, offset]);
          if (!(r.seconds > 0.1)) return text('The sound could not be played (it was empty). Try again with different words.');
          total += Math.max(0, r.played - offset);
          if (!r.interrupted) break;
          // something loud while I spoke: let it end (quiet for 0.8 s, at most 10 s), then hear what it was
          await page.waitForFunction(() => performance.now() - (window.__agentVoice.lastLoud || 0) > 800, null, { timeout: 10000, polling: 200 }).catch(() => {});
          const words = await heardWords(await take(), hint, saidBefore);
          if (words === null || interrupts(words)) { reply = words; break; }
          // a noise, a word or two, or my own echo: carry on from just before where I stopped
          noises.push(words || 'a noise');
          if (noises.length >= 3) await inPage(() => { window.__agentVoice.noBarge = true; });   // a noisy room: stop pausing for it
          offset = Math.max(0, r.played - 0.4);
        }
        if (reply !== null) {
          const b = await beforeP;
          return text((b ? `(Before you spoke they had said: "${b}".) ` : '') + `They interrupted you${said.length ? ` after: "${said.join(' ')}"` : ' at the start'} (stopped mid-sentence: "${parts[i]}"). ` +
            (reply ? `They said: "${reply}". Answer that; keep it short.` : 'Listen to them now (listen).'));
        }
        said.push(parts[i]);
      }
    } finally { await inPage(() => { window.__agentVoice.noBarge = false; }).catch(() => {}); }
    let out = `Said it (${total.toFixed(1)} s).` + (noises.length ? ` (${noises.length} time(s) a sound made you pause: ${noises.map(n => `"${n}"`).join(', ')}; you carried on.)` : '');
    const b = await beforeP; if (b) out += ` Before you spoke they had said: "${b}".`;
    if (then_listen) {
      const heard = await listenNow(listen_seconds, true, hint);
      out += heard === null ? ' (No speech-to-text here: install whisper.cpp to hear words.)' : heard ? ` They replied: "${heard}"` : ` They said nothing in ${listen_seconds} s.`;
    }
    return text(out);
  });

server.tool('listen', 'Hear what they say in your call: by default it returns as soon as they have said something and finished their sentence (or after seconds, if nothing comes). Your own voice coming back and noises are left out. Everything heard is given once: a later listen has only what comes after.',
  { seconds: z.number().min(1).max(30).default(20).describe('wait at most this long'), until_quiet: z.boolean().default(true).describe('return when they finish speaking; false: wait the whole time, then report everything heard'),
    raw_audio: z.boolean().default(false).describe('also return the audio itself (WAV) instead of only words') },
  async ({ seconds, until_quiet, raw_audio }) => {
    needVoice();
    if (until_quiet) await untilQuiet(seconds); else await page.waitForTimeout(seconds * 1000);
    const r = await take();
    if (!r || r.seconds < 0.2) return text('Nothing heard.');
    if (r.silent) return text(`${r.seconds.toFixed(0)} s of silence.`);
    const said = await heardWords(r, await namesNear());
    const content = [];
    if (said !== null) content.push({ type: 'text', text: said ? `Heard (${r.seconds.toFixed(0)} s): "${said}"` : `${r.seconds.toFixed(0)} s, no words heard (only noise, or your own voice).` });
    else content.push({ type: 'text', text: `${r.seconds.toFixed(1)} s of call audio; no speech-to-text on this computer (install whisper.cpp, e.g. brew install whisper-cpp, and a ggml model) ${raw_audio ? 'the audio follows' : 'raw_audio: true gives the audio'}.` });
    if (raw_audio) content.push({ type: 'audio', data: r.wav, mimeType: 'audio/wav' });
    return { content };
  });

server.tool('hang_up', 'Leave your call.', {},
  async () => { needVoice(); await pace(); await inPage(() => window.__agentCall?.leave()); return text('You left the call.'); });

server.tool('leave', 'Leave Toy City.', {},
  async () => { clearInterval(walker); stopFollowing(); spoken.length = 0; await leaveGame(); return text('You left Toy City.'); });

// knocks at your home (and other messages) arrive while you wait; nothing else is needed for that
await server.connect(new StdioServerTransport());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await leaveGame(); process.exit(0); });
process.stdin.on('close', async () => { await leaveGame(); process.exit(0); });
process.on('exit', () => { try { kokoro?.proc?.kill(); } catch {} });   // the client went away
