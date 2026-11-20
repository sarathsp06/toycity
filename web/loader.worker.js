// Background loader: downloads, un-gzips and parses square files and decodes aerial photos off the
// main thread, then hands over the raw buffers without copying. The page only creates GPU buffers.
// development aid: city.html?net=<latency ms>,<Mbit/s> makes every download behave like a slower connection
let NET = null, line = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Files are also kept in the browser's Cache Storage, so a revisited area loads without the network.
// The cache name carries the region's build stamp from tiles.json: a new bake starts a fresh cache.
// At most CACHE_MAX files are kept; the oldest go first.
let cache = null, cacheP = null, puts = 0;
const CACHE_MAX = 1500;
async function get(url, signal) {
  if (cacheP) { cache = await cacheP; cacheP = null; }
  const hit = cache && await cache.match(url);
  if (hit) return hit;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(res.status + ' ' + url);
  if (!NET) { if (cache) remember(url, res.clone()); return res; }
  const blob = await res.blob();
  // the line is shared: each file waits for the ones before it (each of the two loaders gets half)
  const now = performance.now(), start = Math.max(now + NET[0], line);
  line = start + blob.size * 8 / (NET[1] * 500);
  await sleep(line - now);
  if (signal.aborted) throw new Error('cancelled');
  if (cache) remember(url, new Response(blob));
  return new Response(blob);
}
async function remember(url, res) {
  try {
    await cache.put(url, res);
    if (++puts % 50 === 0) { const keys = await cache.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) await cache.delete(k); }
  } catch { /* storage full or unavailable: just do without */ }
}
async function loadBin(url, signal) {
  const res = await get(url, signal);
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const hl = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  return { header, buf: buf.slice(4 + hl) }; // blob offsets are relative to the end of the header
}
async function loadImage(url, signal) {
  const res = await get(url, signal);
  return createImageBitmap(await res.blob(), { imageOrientation: 'flipY' });
}
const running = new Map();   // request id -> AbortController
self.onmessage = async ({ data: { id, files, images, net, cancel, cacheName } }) => {
  if (net) { NET = net; return; }
  if (cacheName) { cacheP = self.caches ? caches.open(cacheName).catch(() => null) : Promise.resolve(null); return; }
  if (cancel) { running.get(cancel)?.abort(); return; }
  const ac = new AbortController(); running.set(id, ac);
  try {
    const out = { id, files: {}, images: {} }, transfer = [];
    await Promise.all([
      ...Object.entries(files).map(async ([k, url]) => { const r = await loadBin(url, ac.signal); out.files[k] = r; transfer.push(r.buf); }),
      ...Object.entries(images).map(async ([k, url]) => { const b = await loadImage(url, ac.signal); out.images[k] = b; transfer.push(b); }),
    ]);
    self.postMessage(out, transfer);
  } catch (e) {
    self.postMessage({ id, error: ac.signal.aborted ? 'cancelled' : String(e) });
  } finally {
    running.delete(id);
  }
};
