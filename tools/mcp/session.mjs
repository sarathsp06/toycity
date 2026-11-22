// One agent's time in Toy City: the session owns the browser tab the body lives in, its speech engines
// and the conversation (turn.mjs), and notices when the page goes away (a crash, the shared browser
// closing): from then on every tool says so plainly, instead of failing on a dead page each time.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultSpeech, fetchVad } from './speech.mjs';
import { createTurns } from './turn.mjs';

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
  const exe = chromePath(); if (exe) return exe;
  const cli = fileURLToPath(new URL('./node_modules/playwright-core/cli.js', import.meta.url));
  try { execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'ignore', timeout: 600000 }); } catch { /* reported below */ }
  return chromePath();
}
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

// ---------- the call, as turn.mjs sees it ----------
// Each port is one page.evaluate; waits run in the page (checked every 30 ms) rather than as polls
// from here, so a turn ends within a frame or two of the quiet it waits for.
export function pageBridge(page) {
  const ev = (fn, arg) => page.evaluate(fn, arg);
  // (quietMs: how long they had been quiet when it was taken; TOYCITY_DEBUG logs the turn timings with it)
  const take = () => ev(() => { const v = window.__agentVoice, a = v?.take?.(); return a ? { ...a, quietMs: Math.round(performance.now() - (v.lastLoud || 0)) } : null; });
  return {
    begin: () => ev(() => ({ members: window.__agentCall?.members.length || 0, audio: window.__agentVoice?.take?.() || null,
      hint: [...(window.__city.social?.presence.peers.values() || [])].filter(q => q.dist < 60).map(q => (q.name || '').replace(/^🤖\s*/, '')).filter(Boolean).slice(0, 6).join(', ') })),
    say: (wav, offset) => ev(([b, o]) => window.__agentCall?.members.length ? window.__agentVoice.say(b, o) : { ended: true }, [wav, offset]),
    take,
    heardQuiet: (ms, max) => ev(([ms, max]) => new Promise(done => {
      const v = window.__agentVoice, t0 = performance.now();
      const tick = () => { if (v && v.heardSince > 0 && performance.now() - v.lastLoud >= ms) return done(true); if (performance.now() - t0 >= max) return done(false); setTimeout(tick, 30); };
      tick();
    }), [ms, max]),
    holdQuiet: (ms, max) => ev(([ms, max]) => new Promise(done => {
      const v = window.__agentVoice, t0 = performance.now();
      const tick = () => { if (!v) return done('done'); if (v.heardSince > 0) return done('more'); if (performance.now() - v.lastLoud >= ms || performance.now() - t0 >= max) return done('done'); setTimeout(tick, 30); };
      tick();
    }), [ms, max]),
    wait: ms => page.waitForTimeout(ms),
    noBarge: on => ev(on => { if (window.__agentVoice) window.__agentVoice.noBarge = on; }, on),
  };
}

// ---------- the in-page agent (web/agent.js) ----------
// from the site the game came from, so it matches that game; a site that doesn't serve it yet (an
// older deploy) gets this checkout's copy
const LOCAL_AGENT = fileURLToPath(new URL('../../web/agent.js', import.meta.url));
async function installAgent(page, site) {
  try { await page.addScriptTag({ type: 'module', url: site + 'agent.js' }); }
  catch {
    if (!fs.existsSync(LOCAL_AGENT)) throw new Error('This copy of Toy City has no agent.js, and none is next to this server.');
    await page.addScriptTag({ type: 'module', content: fs.readFileSync(LOCAL_AGENT, 'utf8') });
  }
  await page.waitForFunction(() => window.__agentApi, null, { timeout: 15000 });
}

export class Session {
  constructor({ site, speech = defaultSpeech, voice = 'af_heart' } = {}) {
    this.site = site; this.makeSpeech = speech; this.voice = voice;
    this.browser = this.ctx = this.page = null; this.me = null; this.hasVoice = false; this.gone = null;
    this.speech = null; this.turns = null; this.lease = null; this.leaseT = null;
  }
  // ready to act: in the game, on a live page
  need() {
    if (this.page) return;
    throw new Error(this.gone ? `The game page ${this.gone}; use join again.` : 'Not in Toy City yet: call join first.');
  }
  needVoice() { this.need(); if (!this.hasVoice) throw new Error('You joined without a voice: leave and join again with voice: true.'); }
  api(method, ...args) { return this.page.evaluate(([m, a]) => window.__agentApi[m](...a), [method, args]); }

  async open({ url, name, voice }) {
    this.gone = null;
    this.browser = await sharedBrowser(); this.keepLease(true);
    this.hasVoice = voice;
    if (voice) {   // warmed up now, not at the first word
      this.speech ||= this.makeSpeech();
      this.speech.tts.warm?.(); fetchVad().then(() => this.speech?.stt.warm?.());
      const page = () => this.page;
      this.turns = createTurns({ bridge: lazyBridge(page), tts: this.speech.tts, stt: this.speech.stt, voice: () => this.voice });
    }
    this.ctx = await this.browser.newContext({ viewport: { width: 960, height: 600 } });
    this.me = name;
    await this.ctx.addInitScript(n => { localStorage.setItem('toycity.name', n); localStorage.setItem('toycity.view', 'chase'); }, name);
    const page = this.page = await this.ctx.newPage();
    // a page that dies takes the body with it: forget it, so tools say so instead of throwing on it
    page.on('crash', () => this.lost(page, 'crashed'));
    page.on('close', () => this.lost(page, 'closed'));
    this.onDisconnect = () => this.lost(page, 'closed (the browser went away)');
    this.browser.on('disconnected', this.onDisconnect);
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__agent, null, { timeout: 120000 });
    await installAgent(page, this.site);
  }
  lost(page, why) {
    if (this.page !== page) return;   // an old page, or one we closed ourselves
    this.page = null; this.gone = why; this.turns?.reset();
    this.ctx?.close().catch(() => {}); this.ctx = null;
    const b = this.browser; this.browser = null; b?.off?.('disconnected', this.onDisconnect); b?.close().catch(() => {});
    this.keepLease(false);
  }
  async close() {
    const page = this.page; this.page = null; this.gone = null;
    if (page) await page.evaluate(() => window.__agentApi?.leave()).catch(() => {});
    this.turns?.reset();
    this.keepLease(false);
    this.browser?.off?.('disconnected', this.onDisconnect);
    await this.ctx?.close().catch(() => {}); await this.browser?.close().catch(() => {});
    this.browser = this.ctx = null;
  }
  stopSpeech() { this.speech?.tts.close?.(); this.speech?.stt.close?.(); this.speech = null; }
  keepLease(on) {
    clearInterval(this.leaseT);
    if (!on) { if (this.lease) fs.rmSync(this.lease, { force: true }); this.lease = null; return; }
    fs.mkdirSync(HOST_DIR, { recursive: true }); this.lease = path.join(HOST_DIR, `${process.pid}.lease`);
    const touch = () => fs.writeFileSync(this.lease, String(Date.now())); touch(); this.leaseT = setInterval(touch, 30000);
  }
}
// the bridge of whatever page is current (a turn started on a page that then closed fails cleanly)
function lazyBridge(getPage) {
  let page = null, b = null;
  const cur = () => { const p = getPage(); if (!p) throw new Error('The game page closed; use join again.'); if (p !== page) { page = p; b = pageBridge(p); } return b; };
  return new Proxy({}, { get: (_, k) => async (...a) => cur()[k](...a) });
}
