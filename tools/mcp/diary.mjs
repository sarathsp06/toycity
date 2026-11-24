// The voice diary: everything that went wrong, or just oddly, with hearing and speaking in Toy City,
// kept so it can be turned into a report for whoever works on the voice. One JSON line per entry in
// ~/.toycity/voice-diary.jsonl (TOYCITY_DIARY overrides): { at, kind, text, data }. The engines and the
// turn policy write to it as they go (speech.mjs, turn.mjs, server.mjs); the agent adds what it noticed
// itself with the note_voice_issue tool, and voice_report renders it all as one prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FILE = process.env.TOYCITY_DIARY || path.join(os.homedir(), '.toycity', 'voice-diary.jsonl');
const KINDS = new Set(['setup', 'engine', 'turn', 'call', 'agent']);   // what failed to start, an engine error, how a turn went, the call itself, what the agent noticed

export function note(kind, text, data) {
  if (!KINDS.has(kind)) kind = 'agent';
  const entry = { at: new Date().toISOString(), kind, text: String(text).slice(0, 2000), ...(data !== undefined ? { data } : {}) };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.appendFileSync(FILE, JSON.stringify(entry) + '\n'); } catch { /* a diary that cannot be written is not worth failing a call for */ }
  return entry;
}

export function read(sinceMs = 0) {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const l of lines) { try { const e = JSON.parse(l); if (!sinceMs || Date.parse(e.at) >= sinceMs) out.push(e); } catch { /* a torn line */ } }
  return out;
}

export function clear() { try { fs.unlinkSync(FILE); } catch { /* nothing to clear */ } }

// the diary as a report someone can paste to the voice's developer: what the agent is, what was
// seen, grouped by kind, with the raw entries at the end
export function report(entries, { who = 'an AI player', since } = {}) {
  if (!entries.length) return 'Nothing in the voice diary: no difficulties were recorded.';
  const by = {}; for (const e of entries) (by[e.kind] ||= []).push(e);
  const titles = { setup: 'Set-up (what was missing or failed to start)', engine: 'Speech engines (text-to-speech, speech-to-text)', turn: 'Turns (how hearing and speaking went)', call: 'Calls', agent: 'What the agent itself noticed' };
  const lines = [`# Toy City voice: what went wrong for ${who}`, '', `${entries.length} entries${since ? ` since ${since}` : ''}, from ${entries[0].at} to ${entries[entries.length - 1].at}. Please read this as a bug report from an AI player using the MCP voice tools (say, listen, call); each line is one thing it ran into.`, ''];
  for (const k of ['setup', 'engine', 'call', 'turn', 'agent']) {
    if (!by[k]) continue;
    lines.push(`## ${titles[k]}`, '');
    const counts = {}; for (const e of by[k]) counts[e.text] = (counts[e.text] || 0) + 1;
    for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40)) lines.push(`- ${t}${n > 1 ? ` (${n}×)` : ''}`);
    lines.push('');
  }
  lines.push('## Raw entries', '', '```', ...entries.slice(-200).map(e => JSON.stringify(e)), '```');
  return lines.join('\n');
}
