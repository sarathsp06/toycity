// Records the README tour: a short look at what you can do in Barendrecht (a person talking with an AI player,
// jumping onto a car, driving, swimming, then the camera pulls out over the town). Needs the dev server
// (python3 tools/serve.py 8765) and playwright-core; uses the GPU, so the clip plays in real time.
// It writes a video to /tmp/gif2/v and prints when each scene starts and ends. Screencast frames are
// 960x452 inside a 960x540 video, so crop, cut the scenes (times from the printout) and join, then:
//   ffmpeg -i tour.mp4 -vf "fps=9,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=80:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/img/tour.gif
// Usage: node tools/capture/tour_gif.mjs
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const B = 'http://localhost:8765/city.html?place=barendrecht&fakemic=1';
const args = ['--use-angle=metal', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const SIZE = { width: 960, height: 540 };
const open = async (url, name, video) => {
  const br = await chromium.launch({ executablePath: exe, args });
  const ctx = await br.newContext({ viewport: SIZE, permissions: ['microphone'], ...(video ? { recordVideo: { dir: '/tmp/gif2/v', size: SIZE } } : {}) });
  await ctx.addInitScript(n => { localStorage.setItem('toycity.name', n); localStorage.setItem('toycity.view', 'chase'); localStorage.setItem('toycity.map', '0'); }, name);
  const p = await ctx.newPage(); p.on('pageerror', e => console.log(name, 'ERR', e.message));
  await p.goto(url); return { p, ctx, br };
};
const A = await open(B, 'Anna', true), a = A.p, t0 = Date.now();
await a.waitForTimeout(16000);
// a clean picture: no buttons or panels, only a caption
await a.addStyleTag({ content: `#top,#hint,#zoom,#place,#hud,#mini,#minibtn,#mptoasts,#carbtn,#swimbtn,#apbtn,#nav,#joy,#jumpbtn,#hp,#radiobtn{display:none!important}
  #cap{position:fixed;left:28px;top:22px;font:700 30px system-ui,sans-serif;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.7);z-index:99;transition:opacity .3s}` });
await a.evaluate(() => { const d = document.createElement('div'); d.id = 'cap'; document.body.append(d);
  // move the camera smoothly from inside the page: f(t) gives [yaw, pitch, dist] for t from 0 to 1
  window.__cam = (src, ms) => { const f = new Function('t', 'c', 'return ' + src), s = performance.now();
    return new Promise(r => { const step = () => { const t = Math.min(1, (performance.now() - s) / ms); window.__city.setView(...f(t, window.__city)); t < 1 ? requestAnimationFrame(step) : r(); }; step(); }); }; });
const cap = text => a.evaluate(s => { document.getElementById('cap').textContent = s; }, text);
const marks = [];
const scene = async (name, fn) => { const s = Date.now() - t0; await fn(); marks.push([name, s / 1000, (Date.now() - t0) / 1000]); console.log(name, s / 1000, (Date.now() - t0) / 1000); };

const home = await a.evaluate(() => [window.__city.player.position.x, window.__city.player.position.z]);

// 1. an AI player (🤖, the way tools/mcp joins) comes to the same spot; you call it and it answers
// out loud: its ring lights up while it speaks. /tmp/kk3/clip.wav is any short spoken clip (Kokoro).
await a.evaluate(([x, z]) => { const c = window.__city; c.swim.on = false; c.player.position.set(x, 0.15, z); }, home);
await a.waitForTimeout(1500);
const [X, Y] = await a.evaluate(() => { const c = window.__city; return c.toRD(c.player.position.x, c.player.position.z); });
const J = await open(B.replace('fakemic=1', 'agent=1&voice=1') + `&meet=${X.toFixed(1)},${Y.toFixed(1)}`, '🤖 Robin', false), b = J.p;
for (let k = 0; k < 60; k++) { await a.waitForTimeout(1000); if (await a.evaluate(() => [...document.querySelectorAll('#mpcall .talk')].some(b => b.textContent.includes('Robin')))) break; }
await a.evaluate(() => [...document.querySelectorAll('#mpcall .talk')].find(b => b.textContent.includes('Robin'))?.click());
for (let k = 0; k < 30; k++) { await a.waitForTimeout(500); if (await b.evaluate(() => (window.__agentCall?.members.length || 0) > 0)) break; }
await a.addStyleTag({ content: '#mpcall,#mptoasts{display:none!important}' });
const face = p => p.evaluate(() => { const c = window.__city, q = [...c.social.presence.peers.values()][0]?.player?.group.position, me = c.player.position;
  if (q) c.player.rotation.y = Math.atan2(q.x - me.x, q.z - me.z); });
await face(a); await face(b);
await a.evaluate(() => { const c = window.__city, q = [...c.social.presence.peers.values()][0]?.player?.group.position, me = c.player.position;
  window.__th = q ? Math.atan2(q.x - me.x, q.z - me.z) : 0; window.__mid = q; c.setView(window.__th + Math.PI / 2 - 0.15, 0.28, 6.5); });
await a.waitForTimeout(1200);
const clip = (await import('node:fs')).readFileSync('/tmp/kk3/clip.wav').toString('base64');
await cap('Talk to friends, or to an AI player 🤖');
await scene('talk', async () => {
  await a.waitForTimeout(600);
  await b.evaluate(c => { window.__agentVoice.noBarge = true; return window.__agentVoice.say(c); }, clip);
  await a.waitForTimeout(400);
});
// then it walks off down the street, out of the way
await b.evaluate(() => window.__agentApi.walk(90, 25));

// 2. onto the car parked in front: stand behind it, run at it and jump
const car = await a.evaluate(() => { const c = window.__city, n = c.driving.nearest(c.player.position); return { x: n.x, z: n.z, yaw: n.yaw }; });
// run up along the car's length: the roof is longer that way than across
await a.evaluate(({ x, z }) => { const c = window.__city, p = c.player.position;
  const len = ([ux, uz]) => { let n = 0; for (let r = 0; r < 4; r += 0.1) if ((c.solids.topAt(x + ux * r, z + uz * r, 0.2) ?? 0) > 1) n++; return n; };
  const a = [[1, 0], [0, 1]].sort((u, v) => len(v) - len(u))[0];
  p.x = x + a[0] * 3.2; p.z = z + a[1] * 3.2; c.setView(Math.atan2(p.x - x, p.z - z), 0.25, 7); }, car);
await cap('Jump onto a car roof');
await a.waitForTimeout(700);
await scene('jump', async () => {
  await a.keyboard.down('w'); await a.waitForTimeout(300); await a.keyboard.press(' '); await a.waitForTimeout(900); await a.keyboard.up('w');
  await a.waitForTimeout(500);
  const y = await a.evaluate(() => Math.atan2(window.__city.camera.position.x - window.__city.player.position.x, window.__city.camera.position.z - window.__city.player.position.z));
  await a.evaluate(y => window.__cam(`[${y} + 1.6 * t, 0.3, 7]`, 2500), y);
});

// 3. get in, back out of the bay and pull onto the road by hand (the autopilot drives through parked
// cars on purpose, so it would leave the bay straight through the car in front)
await a.keyboard.press('e'); await a.waitForTimeout(400);
const hold = async (keys, ms) => { for (const k of keys) await a.keyboard.down(k); await a.waitForTimeout(ms); for (const k of keys) await a.keyboard.up(k); };
await hold(['s'], 1500); await a.waitForTimeout(400);
await cap('Drive any parked car');
await scene('drive', async () => { await hold(['w', 'a'], 1500); await hold(['w', 'd'], 700); await hold(['w'], 1100); });
await a.keyboard.press('e');

// 4. the pond with the swans: walk to the edge and swim
const pond = await a.evaluate(() => { const c = window.__city, m4 = c.player.matrix.clone(); let best = null;
  c.player.parent.traverse(o => { if (o.isInstancedMesh && !o.frustumCulled && o.count > 0 && o.count < 200 && o.instanceMatrix.usage === 35048) { o.getMatrixAt(0, m4); const e = m4.elements; if (e[13] < 1 && (!best)) best = [e[12], e[14]]; } });
  return best; });
console.log('birds at', pond);
await cap('Swim in the ponds and canals');
await scene('swim', async () => {
  await a.evaluate(([bx, bz]) => { const c = window.__city, p = c.player.position;
    // the nearest dry spot to the birds, a few metres from the water
    let best = null; for (let r = 4; r < 40 && !best; r += 1) for (let k = 0; k < 24; k++) { const x = bx + Math.cos(k / 24 * 6.283) * r, z = bz + Math.sin(k / 24 * 6.283) * r; if (c.wetAt(x, z) === null && !c.blocked(x, z)) { best = [x, z]; break; } }
    p.x = best[0]; p.z = best[1]; c.player.rotation.y = Math.atan2(bx - p.x, bz - p.z);
    c.setView(Math.atan2(p.x - bx, p.z - bz), 0.3, 8); }, pond);
  await a.waitForTimeout(300);
  await a.keyboard.down('w'); await a.waitForTimeout(900); await a.keyboard.press('g'); await a.waitForTimeout(4200); await a.keyboard.up('w');
}).catch(e => console.log('swim', e.message));

// 5. still swimming, the camera pulls up and out over the town
await cap('Built from open Dutch data · toycity.pages.dev');
await scene('out', () => a.evaluate(() => { const c = window.__city, y = Math.atan2(c.camera.position.x - c.player.position.x, c.camera.position.z - c.player.position.z);
  window.__y0 = y; return window.__cam('[window.__y0 + 0.9 * t, 0.3 + 0.5 * t * t, 8 + 150 * t * t]', 5000); }));

writeFileSync('/tmp/gif2/marks.json', JSON.stringify(marks));
await A.ctx.close(); console.log('video', await a.video().path());
await A.br.close(); await J.br.close();
process.exit(0);
