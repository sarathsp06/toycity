// node --test *.test.mjs   (the voice diary: entries, reading since a time, the report)
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
process.env.TOYCITY_DIARY = path.join(os.tmpdir(), `toycity-diary-${process.pid}.jsonl`);
const { note, read, clear, report, FILE } = await import('./diary.mjs');

test('diary: entries are appended, read back, and rendered as a report', () => {
  clear();
  assert.equal(report(read()), 'Nothing in the voice diary: no difficulties were recorded.');
  note('turn', 'heard a possible fragment: "and"', { seconds: 1.2 });
  note('turn', 'heard a possible fragment: "and"');
  note('agent', 'the name Barendrecht came out as Baindretch');
  note('nonsense', 'an unknown kind becomes agent');
  const all = read();
  assert.equal(all.length, 4); assert.equal(all[3].kind, 'agent'); assert.deepEqual(all[0].data, { seconds: 1.2 });
  const r = report(all, { who: 'Vox' });
  assert.match(r, /what went wrong for Vox/); assert.match(r, /heard a possible fragment: "and" \(2×\)/); assert.match(r, /## What the agent itself noticed/); assert.match(r, /Baindretch/);
  assert.equal(read(Date.now() + 60000).length, 0, 'nothing since the future');
  clear(); assert.ok(!fs.existsSync(FILE));
});
