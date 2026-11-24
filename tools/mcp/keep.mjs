// A body that stays: `server.mjs --keep NAME`. Some MCP clients start a fresh server for every turn of a
// conversation and stop it afterwards, which would take the agent out of the game each time. With
// --keep, the server the client starts is only a front: it passes the MCP messages through, unchanged,
// to one detached server per NAME (the kept body, started on first use), which stays in the game until
// the agent calls leave. Different names are different bodies.
//
//   keepName(argv) -> NAME or null;  keepSocket(NAME) -> the local socket path;  front(NAME, socket)
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function keepName(argv) {
  const i = argv.indexOf('--keep'); if (i < 0) return null;
  const n = String(argv[i + 1] || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return n || 'default';
}
export function keepSocket(name) {
  const dir = path.join(os.tmpdir(), 'toycity-browser'); fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `keep-${name}.sock`);
}
const connect = sock => new Promise(res => { const c = net.connect(sock); c.once('connect', () => res(c)); c.once('error', () => res(null)); });

export async function front(name, sock) {
  let c = await connect(sock);
  if (!c) {   // no kept body yet: start it, detached so it outlives this process
    spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--keep', name],
      { detached: true, stdio: 'ignore', env: { ...process.env, TOYCITY_KEEP_DAEMON: '1' } }).unref();
    for (let i = 0; i < 40 && !c; i++) { await new Promise(r => setTimeout(r, 250)); c = await connect(sock); }
    if (!c) { console.error('toycity: could not start the kept body'); process.exit(1); }
  }
  process.stdin.pipe(c); c.pipe(process.stdout);
  const end = () => process.exit(0);
  process.stdin.on('close', () => { c.end(); end(); });   // the client went away: the body stays
  c.on('close', end); c.on('error', end);
}
