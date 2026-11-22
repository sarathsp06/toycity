import { chromium } from 'playwright-core';
const br = await chromium.launch({ executablePath: process.env.TOYCITY_CHROME, args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];
const mk = async n => { const c = await br.newContext({ viewport: { width: 900, height: 600 } }); await c.addInitScript(n => localStorage.setItem('toycity.name', n), n); const p = await c.newPage(); p.on('pageerror', e => errs.push(n + ': ' + String(e).slice(0, 200))); p.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(n + ': ' + m.text().slice(0, 150)); }); await p.goto('http://localhost:8765/city.html?place=amsterdam&quality=low&agent=1'); await p.waitForFunction(() => window.__agent && document.getElementById('loading')?.classList.contains('done'), null, { timeout: 120000 }); return p; };
const [a, b] = await Promise.all([mk('Alpha'), mk('Beta')]);
await a.waitForTimeout(15000);
const snap = p => p.evaluate(() => { const t = window.__city.traffic, out = {}; for (const c of t.active) out[c.id] = [+c.pos.x.toFixed(1), +c.pos.z.toFixed(1)]; return { n: Object.keys(out).length, out, keys: [] }; });
const [sa, sb] = await Promise.all([snap(a), snap(b)]);
console.log('A sees Beta', await a.evaluate(() => [...window.__city.social.presence.peers.values()].map(q => q.name + '@' + Math.round(q.dist))));
console.log('A keys', sa.keys.join(','), 'cars', sa.n, 'B cars', sb.n);
let same = 0, diffs = [];
for (const id of Object.keys(sa.out)) if (sb.out[id]) { const d = Math.hypot(sa.out[id][0] - sb.out[id][0], sa.out[id][1] - sb.out[id][1]); same++; diffs.push(+d.toFixed(1)); }
console.log('shared ids', same, 'distance between the two views per car (m):', diffs.join(' '));
// radio + mission smoke on A
const r = await a.evaluate(async () => { const c = window.__city; c.radio.next(); await new Promise(r => setTimeout(r, 4000)); const st = c.radio.station?.name, ct = c.radio.element?.currentTime, on = c.radio.on, inCar = c.radio.inCar; await c.missions.offer(); const line = document.getElementById('mission')?.textContent; return { st, ct, line }; });
console.log('radio', r.st, 'on', r.on, 'inCar', r.inCar, 't', r.ct, '| mission offer:', r.line?.slice(0, 120));
await a.evaluate(() => { window.__city.setView(3.6, 0.2, 10); window.__agent.draw(30); }); await a.waitForTimeout(700); await a.screenshot({ path: '/tmp/anim-check/living.jpg', type: 'jpeg', quality: 70 });
console.log('errors', errs); await br.close();
