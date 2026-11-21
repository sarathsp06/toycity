// One headless browser for every Toy City agent on this computer. The first agent to join starts it
// (detached, so it outlives that agent); the others connect to it, and each agent gets its own tab and
// storage. Agents keep a lease file fresh while they play; with no fresh lease for two minutes, the
// browser closes itself. Started by server.mjs; not meant to be run by hand.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.tmpdir(), 'toycity-browser'), INFO = path.join(DIR, 'endpoint.json');
fs.mkdirSync(DIR, { recursive: true });
const exe = process.argv[2] || undefined;
const server = await chromium.launchServer({ headless: true, ...(exe ? { executablePath: exe } : {}),
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });   // muted: call audio is still recorded, just never played out loud
fs.writeFileSync(INFO, JSON.stringify({ ws: server.wsEndpoint(), pid: process.pid }));
const quit = async () => { try { if (JSON.parse(fs.readFileSync(INFO, 'utf8')).pid === process.pid) fs.rmSync(INFO); } catch {} await server.close().catch(() => {}); process.exit(0); };
setInterval(() => {
  const fresh = fs.readdirSync(DIR).filter(f => f.endsWith('.lease')).some(f => Date.now() - fs.statSync(path.join(DIR, f)).mtimeMs < 120000);
  if (!fresh && Date.now() - started > 120000) quit();
}, 15000);
const started = Date.now();
process.on('SIGTERM', quit); process.on('SIGINT', quit);
