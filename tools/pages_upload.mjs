// Uploads dist/site to a Cloudflare Pages project the same way wrangler does (direct upload).
// Needs the project's short-lived upload token in the file named by $CF_PAGES_JWT_FILE.
// Writes dist/manifest.json ({ "/path": hash }); the deployment itself is then created with that manifest.
// Usage: CF_PAGES_JWT_FILE=/tmp/jwt node tools/pages_upload.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { hash } = createRequire(import.meta.url)('blake3-wasm');

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(HERE, 'dist', 'site'), API = 'https://api.cloudflare.com/client/v4/pages/assets';
const jwt = fs.readFileSync(process.env.CF_PAGES_JWT_FILE, 'utf8').trim();
const TYPES = { html: 'text/html', js: 'application/javascript', json: 'application/json', jpg: 'image/jpeg', glb: 'model/gltf-binary', txt: 'text/plain', bin: 'application/octet-stream' };

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(SITE);
const assets = files.filter(f => path.basename(f) !== '_headers').map(f => {
  const b64 = fs.readFileSync(f).toString('base64'), ext = path.extname(f).slice(1);
  return { route: '/' + path.relative(SITE, f).split(path.sep).join('/'), file: f, b64, ext, key: hash(b64 + ext).toString('hex').slice(0, 32) };
});
const call = async (p, body) => {
  for (let k = 0; ; k++) {
    const r = await fetch(API + p, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success !== false) return j;
    if (k >= 3) throw new Error(`${p}: ${r.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 2000 * (k + 1)));
  }
};
const missing = new Set((await call('/check-missing', { hashes: assets.map(a => a.key) })).result);
const todo = assets.filter(a => missing.has(a.key));
console.log(`${assets.length} files, ${todo.length} to upload`);
// batches of at most ~40 MB of base64
let batch = [], size = 0, done = 0;
const flush = async () => {
  if (!batch.length) return;
  await call('/upload', batch.map(a => ({ key: a.key, value: a.b64, metadata: { contentType: TYPES[a.ext] || 'application/octet-stream' }, base64: true })));
  done += batch.length; console.log(`uploaded ${done}/${todo.length}`); batch = []; size = 0;
};
for (const a of todo) { if (size + a.b64.length > 40e6) await flush(); batch.push(a); size += a.b64.length; }
await flush();
await call('/upsert-hashes', { hashes: assets.map(a => a.key) });
fs.writeFileSync(path.join(HERE, 'dist', 'manifest.json'), JSON.stringify(Object.fromEntries(assets.map(a => [a.route, a.key]))));
console.log('manifest written');
