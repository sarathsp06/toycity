// Walking on foot: what a person bumps into, whether a straight line is clear, a way round when it is
// not, and the jump. It knows nothing of squares, tiles or bitmaps: the map comes in as one predicate,
// so the same code runs in the game and, with a fake map, in the unit tests (tests/walker.test.mjs).
//
//   const walker = createWalker({ blockedAt, wetAt, solids, swimming, flying })
//     blockedAt(x, z, h)  is the ground at x, z closed to feet h metres up? (walls always, hedges below 0.5 m)
//     wetAt(x, z)         the water level there, or null on dry land (only asked while swimming)
//     solids              solids.js registry (parked cars, trees, people), or null
//     swimming(), flying()
//   walker.blocked(x, z)                     the body (a 0.3 m cross of probes) at x, z touches something
//   walker.lineClear(x0, z0, x1, z1)         nothing in the way, every 0.4 m
//   walker.localPath(x0, z0, x1, z1)         [[x, z], ...] round what is in the way, or null
//   walker.jump                              { h, v, phase: crouch -> air -> land -> null, t, onHedge }
//   walker.startJump(), walker.stepJump(dt, x, z) once per frame
import { PERSON } from './solids.js';

export const R0 = 0.3;
// the centre and four points R0 around it, flat [dx, dz, ...]: walls are tested at the edge of the body
const PROBES = [0, 0, R0, 0, -R0, 0, 0, R0, 0, -R0];
// jumping: enough to clear a 1.1 m hedge; up to 1.3 m at the top of the arc
export const GRAVITY = 14, JUMP_V = 6, CROUCH_T = 0.12, LAND_T = 0.16, HEDGE_TOP = 1.0;

export function createWalker({ blockedAt, wetAt = () => null, solids = null, swimming = () => false, flying = () => false }) {
  const jump = { h: 0, v: 0, phase: null, t: 0, onHedge: false };
  // feet h metres up. While swimming, water is open, dry land you may step onto ends the swim, walls stay walls
  function blockedAs(x, z, h) {
    if (swimming()) {
      for (let k = 0; k < PROBES.length; k += 2) { const px = x + PROBES[k], pz = z + PROBES[k + 1]; if (wetAt(px, pz) === null && blockedAt(px, pz, h)) return true; }
      return false;
    }
    for (let k = 0; k < PROBES.length; k += 2) if (blockedAt(x + PROBES[k], z + PROBES[k + 1], h)) return true;
    return !flying() && !!solids && solids.hit(x, z, PERSON.r);
  }
  const blocked = (x, z) => blockedAs(x, z, jump.h);
  const lineClear = (x0, z0, x1, z1) => { const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.4) || 1; for (let s = 1; s <= n; s++) if (blocked(x0 + (x1 - x0) * s / n, z0 + (z1 - z0) * s / n)) return false; return true; };

  // A* over a 0.5 m grid around both ends (16 m margin, 120 m across at most), cells tested lazily, then
  // the string pulled straight where the view is clear. Called once per detour, not per frame.
  function localPath(x0, z0, x1, z1) {
    const S = 0.5, M = 16, minX = Math.min(x0, x1) - M, minZ = Math.min(z0, z1) - M;
    const W = Math.min(240, Math.ceil((Math.abs(x1 - x0) + 2 * M) / S)), H = Math.min(240, Math.ceil((Math.abs(z1 - z0) + 2 * M) / S)), N = W * H;
    const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), pass = new Int8Array(N), open = [];   // pass: 0 unknown, 1 clear, 2 blocked
    const cell = (x, z) => Math.min(H - 1, Math.max(0, Math.round((z - minZ) / S))) * W + Math.min(W - 1, Math.max(0, Math.round((x - minX) / S)));
    const wx = i => minX + (i % W) * S, wz = i => minZ + ((i / W) | 0) * S;
    const ok = i => (pass[i] || (pass[i] = blocked(wx(i), wz(i)) ? 2 : 1)) === 1;
    const a = cell(x0, z0); let b = cell(x1, z1);
    if (!ok(b)) {   // the goal itself is in something: the nearest clear cell next to it
      let best = -1, bd = 9; const bx = b % W, bz = (b / W) | 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { const jx = bx + dx, jz = bz + dz; if (jx < 0 || jz < 0 || jx >= W || jz >= H) continue; const j = jz * W + jx, d = dx * dx + dz * dz; if (d < bd && ok(j)) { bd = d; best = j; } }
      if (best < 0) return null; b = best;
    }
    const h = i => { const dx = Math.abs(i % W - b % W), dz = Math.abs(((i / W) | 0) - ((b / W) | 0)); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
    const push = (f, i) => { open.push([f, i]); let k = open.length - 1; while (k) { const q = (k - 1) >> 1; if (open[q][0] <= open[k][0]) break; [open[q], open[k]] = [open[k], open[q]]; k = q; } };
    const pop = () => { const top = open[0], last = open.pop(); if (open.length) { open[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === k) break; [open[m], open[k]] = [open[k], open[m]]; k = m; } } return top; };
    g[a] = 0; push(h(a), a);
    for (let n = 0; open.length && n < 40000; n++) {
      const [, i] = pop(); if (i === b) break;
      const ix = i % W, iz = (i / W) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue; const jx = ix + dx, jz = iz + dz; if (jx < 0 || jz < 0 || jx >= W || jz >= H) continue;
        const j = jz * W + jx; if (!ok(j) || (dx && dz && (!ok(iz * W + jx) || !ok(jz * W + ix)))) continue;   // no cutting corners
        const c = g[i] + (dx && dz ? 1.414 : 1); if (c < g[j]) { g[j] = c; from[j] = i; push(c + h(j), j); }
      }
    }
    if (from[b] < 0) return null;
    const cells = []; for (let i = b; i >= 0; i = from[i]) cells.push(i); cells.reverse();
    const out = []; let k = 0;   // pull the string: the farthest cell still in clear view of the last kept one
    while (k < cells.length - 1) {
      let m = cells.length - 1; for (; m > k + 1; m--) if (lineClear(wx(cells[k]), wz(cells[k]), wx(cells[m]), wz(cells[m]))) break;
      out.push([wx(cells[m]), wz(cells[m])]); k = m;
    }
    if (out.length) out[out.length - 1] = [x1, z1]; else out.push([x1, z1]);
    return out;
  }

  function startJump() { jump.phase = 'crouch'; jump.t = 0; }
  // one frame of the jump for a body standing at x, z: crouch, push off, fly, land (on a hedge's top if
  // it is under you then), and fall again when you walk off that top
  function stepJump(dt, x, z) {
    jump.t += dt;
    if (jump.phase === 'crouch' && jump.t >= CROUCH_T) { jump.phase = 'air'; jump.v = JUMP_V; jump.t = 0; }
    else if (jump.phase === 'land' && jump.t >= LAND_T) { jump.phase = null; }
    if (jump.onHedge && !jump.phase && !blockedAs(x, z, 0)) { jump.onHedge = false; jump.phase = 'air'; jump.v = 0; jump.t = 0; }  // stepped off the top
    if (jump.phase === 'air') {
      jump.v -= GRAVITY * dt; jump.h += jump.v * dt;
      const floor = blockedAs(x, z, 0) ? HEDGE_TOP : 0;   // a hedge is 1.1 m high; land on its top
      if (jump.v < 0 && jump.h <= floor) { jump.h = floor; jump.v = 0; jump.onHedge = floor > 0; jump.phase = 'land'; jump.t = 0; }
    }
  }
  return { jump, blocked, lineClear, localPath, startJump, stepJump };
}
