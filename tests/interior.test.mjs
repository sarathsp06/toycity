// node --test tests/*.test.mjs   (the house's floor plan, web/models/interior.json: every seat can be walked to)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSolids, standOn } from '../web/solids.js';
import { createWalker } from '../web/walker.js';

const plan = JSON.parse(readFileSync(new URL('../web/models/interior.json', import.meta.url)));
const [W, D, H] = plan.size, BODY = 0.22, HEAD = 1.85;
// the room as the game sets it up (interior.js enter, for a door at the origin facing +z): walls are the
// map, furniture the solids, and a body is BODY wide indoors
const solids = createSolids();
solids.add('room', standOn(plan.solids).map(f => ({ ...f, yaw: 0 })));
const inRoom = (x, z, m) => x > -W / 2 + m && x < W / 2 - m && z < -m && z > -D + m;
const walker = createWalker({ blockedAt: (x, z) => !inRoom(x, z, 0.02), solids, step: () => 0.2, radius: () => BODY, ceiling: () => H - HEAD });
const standSpot = s => {   // interior.js standSpot: in front of the seat, else behind, else beside
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
  for (const [a, b] of [[0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75], [1.1, 0], [-1.1, 0]]) { const x = s.x + fx * a + fz * b, z = s.z + fz * a - fx * b; if (!walker.blocked(x, z)) return [x, z]; }
  return null;
};
const door = [0, -1.5];   // where you stand when you have come in

test('the floor plan: nine seats, each with a free spot to stand up at', () => {
  assert.equal(plan.seats.length, 9);
  for (const s of plan.seats) assert.ok(standSpot(s), `no room to stand at the ${s.kind} at ${s.x}, ${s.z}`);
});

test('every seat can be walked to from the door, round the furniture', () => {
  for (const s of plan.seats) {
    const [x, z] = standSpot(s);
    assert.ok(walker.localPath(door[0], door[1], x, z), `no way from the door to the ${s.kind} at ${s.x}, ${s.z}`);
  }
});

test('a walkway all round the room: from the door to each corner and back along the other side', () => {
  const corners = [[-2.5, -7.6], [2.5, -7.6], [2.5, -4.6], [-2.5, -4.6]];   // back-left, back-right, past the kitchen, by the TV
  const free = corners.map(([x, z]) => { for (let r = 0; r < 1; r += 0.1) for (let a = 0; a < 8; a++) { const px = x + Math.sin(a * Math.PI / 4) * r, pz = z + Math.cos(a * Math.PI / 4) * r; if (!walker.blocked(px, pz)) return [px, pz]; } return null; });
  free.forEach((c, i) => assert.ok(c, `corner ${i} is all furniture`));
  for (let i = 0; i < free.length; i++) {
    const a = free[i], b = free[(i + 1) % free.length];
    assert.ok(walker.localPath(a[0], a[1], b[0], b[1]), `no way from corner ${i} to corner ${(i + 1) % free.length}`);
  }
});

// "Nothing merges into what it stands on": a sofa is not one block with the height of its back. Its
// cushion is a surface of its own at the seat's height, and the back and the arms rise above it.
test('every seat is a cushion at its own height, with the back and the arms above it', () => {
  for (const s of plan.seats) {
    const f = plan.solids.find(f => f.parts?.some(p => p.part === 'seat' && Math.abs(p.x - s.x) <= p.hx + 1e-6 && Math.abs(p.z - s.z) <= p.hz + 1e-6));
    assert.ok(f, `the ${s.kind} at ${s.x}, ${s.z} has no cushion under it`);
    const seat = f.parts.find(p => p.part === 'seat'), back = f.parts.find(p => p.part === 'back');
    assert.equal(seat.top, s.h, `${f.name}: the cushion is not at the seat's height`);
    assert.ok(back && back.top > s.h + 0.15, `${f.name}: no back above the cushion`);
    for (const p of f.parts) if (p.part === 'arm') assert.ok(p.top > s.h, `${f.name}: an arm below the cushion`);
  }
});

test('you can stand on every cushion, and the feet are on it, not in the back or in the air', () => {
  const w = createWalker({ blockedAt: (x, z) => !inRoom(x, z, 0.02), solids, step: () => 0.2, radius: () => BODY, ceiling: () => H - HEAD });
  for (const s of plan.seats) {   // anywhere on its cushion (the box is in room axes: the room is not turned here)
    const c = standOn(plan.solids).find(p => p.part === 'seat' && Math.abs(p.x - s.x) <= p.hx + 1e-6 && Math.abs(p.z - s.z) <= p.hz + 1e-6);
    let spot = null;
    for (let i = 0; i <= 20 && !spot; i++) for (let j = 0; j <= 20 && !spot; j++) {
      const x = c.x - c.hx + 2 * c.hx * i / 20, z = c.z - c.hz + 2 * c.hz * j / 20;
      w.jump.h = s.h;
      if (!w.blocked(x, z) && Math.abs(w.floorAt(x, z) - s.h) < 1e-9) spot = [x, z];
    }
    assert.ok(spot, `nowhere to stand on the ${s.kind} at ${s.x}, ${s.z}`);
  }
});
