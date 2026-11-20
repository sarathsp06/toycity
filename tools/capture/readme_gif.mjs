// Records the README clip: two headless players meet in Barendrecht, start a call (a test tone
// stands in for the microphone) and the camera swings slowly around them. Needs the dev server
// (python3 tools/serve.py 8765) and playwright-core. Frames go to /tmp/gif; then:
//   ffmpeg -framerate 12 -i /tmp/gif/f%03d.png -vf "fps=10,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" docs/img/talk.gif
// Usage: N=72 node tools/capture/readme_gif.mjs
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const B = 'http://localhost:8765/city.html?place=barendrecht&fakemic=1';
const args = ['--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const open = async (url, name, size) => {
  const br = await chromium.launch({ executablePath: exe, args });
  const ctx = await br.newContext({ viewport: size, permissions: ['microphone'] });
  await ctx.addInitScript(n => { localStorage.setItem('toycity.name', n); localStorage.setItem('toycity.view', 'chase'); localStorage.setItem('toycity.map', '0'); }, name);
  const p = await ctx.newPage(); p.on('pageerror', e => console.log(name, 'ERR', e.message));
  await p.goto(url); return p;
};
const a = await open(B, 'Anna', { width: 960, height: 540 });
await a.waitForTimeout(12000);
const [X, Y] = await a.evaluate(() => { const c = window.__city; return c.toRD(c.player.position.x, c.player.position.z); });
const b = await open(B + `&meet=${X.toFixed(1)},${Y.toFixed(1)}`, 'Joost', { width: 640, height: 400 });
for (let k = 0; k < 60; k++) { await a.waitForTimeout(1000); if (await a.evaluate(() => [...window.__city.social?.presence?.peers?.values?.() || []].some(p => p.player?.group.visible))) break; }
console.log('A sees', await a.evaluate(() => [...window.__city.social.presence.peers.values()].map(p => p.name + ' ' + p.dist.toFixed(1))));
await a.click('#mpcall .talk'); await b.waitForSelector('#mptoasts .ring button', { timeout: 15000 }); await b.click('#mptoasts .ring button');
await a.waitForTimeout(6000);
console.log('call', await a.evaluate(() => document.getElementById('mpcall').innerText));
// clean frame: only the call bar stays
await a.addStyleTag({ content: '#top,#hint,#zoom,#place,#hud,#mini,#minibtn,#mptoasts{display:none!important}' });
const face = p => p.evaluate(() => { const c = window.__city, q = [...c.social.presence.peers.values()][0]?.player?.group.position, me = c.player.position;
  if (q) c.player.rotation.y = Math.atan2(q.x - me.x, q.z - me.z); });
await face(a); await face(b); await a.waitForTimeout(2500);
const N = +(process.env.N || 60);
for (let k = 0; k < N; k++) {
  await a.evaluate(t => { const c = window.__city, s = c.social; const q = [...s.presence.peers.values()][0]?.player?.group.position, me = c.player.position;
    const mid = q ? { x: (q.x + me.x) / 2, z: (q.z + me.z) / 2 } : me;
    const th = q ? Math.atan2(q.x - me.x, q.z - me.z) : 0; c.setView(th + (1) * Math.PI / 2 + 0.3 * Math.sin(t * 2 * Math.PI), 0.3, 7); }, k / N);
  await a.screenshot({ path: `/tmp/gif/f${String(k).padStart(3, '0')}.png` });
}
process.exit(0);
