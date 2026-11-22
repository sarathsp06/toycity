// development aid: city.html?drive=<m/s>[&len=<m>][&angle=<rad>] moves the player in a straight line
// through the town and records frame times and missing squares; the result lands in window.__driveResult
import { squareKey } from './grid.js';

export async function run(c, speed, len = 2400, angle = 0) {
  await new Promise(r => setTimeout(r, 100));
  const info = c.info, T = info.tile, N = info.overview?.n || 4;   // the region's own tiles.json (window.__city.info)
  const rect = (i, j, X, Y) => Math.hypot(Math.max(i * T - X, 0, X - (i + 1) * T), Math.max(j * T - Y, 0, Y - (j + 1) * T));
  const p = c.player.position, dx = Math.cos(angle), dz = Math.sin(angle), x0 = -dx * len / 2, z0 = -dz * len / 2;
  p.set(x0, p.y, z0);
  await new Promise(r => setTimeout(r, 8000));
  const frames = [], holesNear = [], holesFar = [], noSquare = []; let last = performance.now(), t = 0; const slow = [];
  await new Promise(done => {
    function step(now) {
      const dt = (now - last) / 1000; last = now; frames.push(dt * 1000); t += dt;
      if (dt > 0.05) slow.push([+(t * speed).toFixed(0), +(dt * 1000).toFixed(0)]);
      const s = Math.min(t * speed, len); p.x = x0 + dx * s; p.z = z0 + dz * s;
      if (frames.length % 6 === 0) {
        const [X, Y] = c.toRD(p.x, p.z); let hn = 0, hf = 0, ns = 0;
        for (const [i, j] of info.squares) {
          const d = rect(i, j, X, Y), tl = c.tiles.get(squareKey(i, j));
          if (d < 150 && (!tl || tl.level !== 'near')) hn++;
          const ov = c.ovTiles.get(squareKey(Math.floor(i / N), Math.floor(j / N)));
          if (d < 800 && !tl && (!ov || ov === 'loading')) hf++;
          if (d < 800 && !tl) ns++;
        }
        holesNear.push(hn); holesFar.push(hf); noSquare.push(ns);
      }
      if (s >= len) return done();
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
  frames.shift(); frames.sort((a, b) => a - b);
  const q = k => +frames[Math.floor(frames.length * k)].toFixed(1);
  const pct = a => +(100 * a.filter(h => h > 0).length / a.length).toFixed(1);
  window.__driveResult = { speed, frames: frames.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +frames.at(-1).toFixed(1),
    over33ms: frames.filter(f => f > 33).length, nearMissingPct: pct(holesNear), noSquarePct: pct(noSquare), emptyPct: pct(holesFar), slow, stats: c.stats };
}
