// Walking test against a local server: walk_to an address ends at its front door, then follow a
// walking player and keep up. Run from tools/mcp with the game served locally (python3 tools/serve.py):
//   TOYCITY_URL=http://localhost:8765/ TOYCITY_CHROME=<a chromium> node test-walk.mjs
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exe = process.env.TOYCITY_CHROME, SITE = process.env.TOYCITY_URL;
const c = new Client({ name: 't', version: '1' }); await c.connect(new StdioClientTransport({ command: 'node', args: ['server.mjs'], env: { ...process.env } }));
const A = async (tool, args = {}) => (await c.callTool({ name: tool, arguments: args })).content.map(x => x.type === 'text' ? x.text : `[${x.type}]`).join(' ');
const L = async () => JSON.parse(await A('look'));
await A('join', { town: 'barendrecht', near: 'Koedoodsekade 10', name: 'Nav' });
console.log('walk_to ->', await A('walk_to', { place: 'Koedoodsekade 16' }));
for (let t = 0; t < 24; t += 3) { const l = await (async () => { await A('wait', { seconds: 3 }); return L(); })(); console.log(t, l.nearest_address, l.doing, JSON.stringify(l.front_door), l.at_door); }
// the walker
const br = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader'] });
const ctx = await br.newContext({ viewport: { width: 700, height: 450 } });
await ctx.addInitScript(() => localStorage.setItem('toycity.name', 'Walker'));
const p = await ctx.newPage(); await p.goto(SITE + 'city.html?place=barendrecht&agent=1&quality=low');
await p.waitForFunction(() => window.__agent && document.getElementById('loading')?.classList.contains('done'), null, { timeout: 120000 });
await p.evaluate(() => window.__city.goTo('Koedoodsekade 16')); await p.waitForTimeout(4000);
for (let i = 0; i < 60; i++) { await p.waitForTimeout(1000); if ((await L()).people.some(q => q.name.includes('Walker'))) break; }
console.log('people', JSON.stringify((await L()).people));
console.log('follow ->', await A('follow', { name: 'Walker' }));
await p.evaluate(async () => { const c = window.__city, P = c.player.position, pts = await c.autopilot.plan({ x: P.x, z: P.z, fx: 0, fz: -1 }, { x: P.x + 90, z: P.z - 60 }, 'foot'); window.__w = { pts, i: 0 };
  setInterval(() => { const w = window.__w; if (window.__agent.walking || w.i >= w.pts.length) return; const [x, z] = w.pts[w.i++]; window.__agent.walkTo(x, z, false); }, 200); });
for (let t = 0; t < 40; t++) { await p.waitForTimeout(1000); const l = await L(); const w = l.people.find(q => q.name.includes('Walker')); const wp = await p.evaluate(() => { const P = window.__city.player.position; return [P.x.toFixed(1), P.z.toFixed(1), window.__agent.walking, window.__w.i]; }); console.log('t', t, 'walker', wp.join(','), 'agent sees', w ? `${w.metres}m ${w.doing}` : 'lost', l.doing, l.following); if (!w) break; }
await A('leave'); await br.close(); process.exit(0);
