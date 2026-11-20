# Streaming the Netherlands: rendering architecture

Status 2026-11-20. Rotterdam and Barendrecht (one region, 670 squares) run on this design today. Items marked **next** are not built yet.

## 1. High-level architecture

```
 PDOK (BGT, BAG, aerial), 3D BAG, OSM            offline, on a build machine
        │  tilebake.py        fetch + clip per 500 m square  -> data/<region>/raw/I_J.json
        │  tools/buildtiles.mjs   triangulate, extrude, place  -> t/I_J.{b,d,f}.bin  (near, near, far)
        │  tools/overview.mjs     merge into blocks per 2 km    -> o/OI_OJ.bin
        │  tools/overview_aerial.py  aerial mosaic per 2 km     -> o/OI_OJ.jpg
        ▼
 static files (tiles.json, t/, a/, o/)  ── CDN ──►  browser
                                                    ├─ 2 loader workers: fetch, gunzip, decode JPEG, Cache Storage
                                                    └─ main thread: choose squares, upload buffers, three.js render
```

No database and no server logic: the CDN is a plain file server. The browser never sees raw OSM,
BGT or BAG data; it only uploads ready-made vertex buffers.

Coordinates: everything is baked in RD New (EPSG:28992), metres. The page picks one origin near the
start position and uses three.js x = east, z = -north relative to it, so float32 precision stays at
millimetres. RD is metric and nearly conformal over the whole country, so a fixed 500 m grid works
for all of the Netherlands without reprojection in the browser.

## 2. Quadtree

The RD grid is the quadtree. A node is `(level, i, j)` with size `500 · 2^level` m and bounds
`[i·size, j·size] – [(i+1)·size, (j+1)·size]`. Children are `(level-1, 2i+a, 2j+b)`.

Only every second level carries geometry, so a parent covers 4 × 4 children. This halves the
number of files and requests, and a 1 km level would look almost the same as 2 km from where it is
used.

| Level | Size | Contents | Shown at | Built |
|---|---|---|---|---|
| 0 near | 500 m | LoD 2.2 buildings with doors and windows, streets, trees, cars, collision, labels, 25 cm aerial | < 200 m | yes |
| 0 far | 500 m | LoD 1.2 blocks, 1 m aerial | < 1.1 km | yes |
| 2 overview | 2 km | footprints unioned per height band, 1.5 m simplified, flat roofs, 2 m aerial mosaic | to the horizon (4.5 km) | yes |
| 4 region | 8 km | only large blocks and a 8 m mosaic | 4.5 – 15 km | **next** (needed beyond one town) |

Every level is generated from the same source footprints and heights, so the levels agree with each
other.

Nodes are discovered lazily. Today a region has one flat `tiles.json` (fine up to about 10,000
squares). At country scale it becomes a small index per level-4 node:

## 3. Metadata schema

`tiles.json` (today, per region):

```json
{ "tile": 500, "title": "Barendrecht", "build": "mwomcza6",
  "squares": [[188, 858], ...],
  "quant": { "q": 0.02, "ox": 400, "oy": 50, "oz": 910 },
  "overview": { "size": 2000, "n": 4, "q": 0.05, "margin": 100, "tiles": [[47, 214], ...] } }
```

**next**, country scale: `q/root.json` lists the 8 km nodes that have data, and one
`q/4/I_J.json` per 8 km node lists its children:

```json
{ "level": 4, "i": 11, "j": 53, "build": "mwomcza6",
  "overview": [[46, 214, 202000], [46, 215, 262000]],
  "squares": { "184_860": [240000, 610000, 98000], "185_858": [...] } }
```

Each child entry holds byte sizes, so the loader can estimate download time. The root of the
Netherlands is about 600 entries, and the browser only fetches the 8 km nodes within the horizon.

## 4. CDN layout

```
/regions/<region>/tiles.json           no-cache (or max-age=60): it carries the build stamp
/regions/<region>/t/I_J.b.bin  .d.bin  .f.bin      gzip, immutable per build
/regions/<region>/a/I_J.jpg   I_J_s.jpg            aerial, near and far
/regions/<region>/o/OI_OJ.bin  OI_OJ.jpg           overview
```

**next** for production: put the build stamp in the path (`/b/mwomcza6/t/...`) and serve everything
under it with `Cache-Control: public, max-age=31536000, immutable`. Only the small index stays
short-lived.

## 5. Offline pipeline

1. `tilebake.py <region>`: download and clip BGT surfaces, BAG/3D BAG buildings (LoD 1.2 and 2.2),
   OSM extras and the aerial photo per 500 m square.
2. `tools/buildtiles.mjs <region> [--shard k/n]`: per square, triangulate and extrude, place
   instances (trees, lamps, cars, furniture), build the collision grid, quantise positions to 2 cm
   Uint16 and normals to Int8, gzip.
3. `tools/overview.mjs <region>`: union footprints per square and 3 m height band
   (polygon-clipping), simplify to 1.5 m, extrude, quantise to 5 cm. All of Barendrecht becomes
   2 MB and 180,000 triangles, in 2 seconds.
4. `tools/overview_aerial.py <region>`: stitch the small aerial photos into one 1024 px image per
   2 km.

Every step is per tile and independent, so it shards across machines.

## 6. Choosing squares in the browser (built)

```ts
every 0.3 s:
  v = smoothed velocity from recent positions          // m/s, RD east/north
  path = segment from player to player + v · 4 s
  for square in the grid around the player (bounded by far range + path length):
    d    = distance(square, player)
    dp   = distance(square, path)                       // 25 m samples
    soon = min over samples s of distance(square, s) + metres to reach s
    level = dp < near ? 'near' : dp < far ? 'far' : none
    if loaded as near and d < near + 80  -> keep near     // hysteresis
    if loaded and d < far + 160          -> keep (far)
    priority = soon + 400·(behind camera) + 250·(already has a level) - 1000·(near, < 60 m)
  unload squares no longer wanted; cancel their downloads
  start the best-ranked downloads, at most 4 at a time
  overview tiles within the horizon are loaded as well
```

The grid scan is a 2D quadtree query at one level. At country scale the same scan runs per level
over the 8 km index nodes in range, so it never touches the whole country.

## 7. Fast vehicles (built)

- The look-ahead path makes squares on the road ahead count as close. At 100 m/s that is 400 m.
- Priority is "how soon will I be near it", so the square under the player beats one 400 m ahead,
  and both beat one behind the camera.
- A download for a square that leaves the wanted set is cancelled in the worker (AbortController).
  A far file still on its way when its square turns near is kept: it costs about 0.2 MB and fills
  the gap.
- At most 4 concurrent downloads, so the nearest ones are not starved.
- Decoded squares are applied within a 6 ms per-frame budget.

Measured on Barendrecht, driving 2.4–3 km in a straight line over a simulated 80 ms / 20 Mbit/s
connection (`city.html?drive=<m/s>&net=80,20`):

| | 30 m/s before | 30 m/s after | 100 m/s before | 100 m/s after |
|---|---|---|---|---|
| time with an empty patch within 800 m | 1.3 % | 0 % | 16.4 % | 0 % |
| time without full detail within 150 m | 4.1 % | 0 % | 65.8 % | 10.5 % |
| worst frame | 40 ms | 28 ms | 41 ms | 42 ms |

**Next:** scale the look-ahead time with measured download time, so a slower connection looks
further ahead automatically.

## 8. LOD transitions and parent fallback (built)

- A square only replaces its previous level once the new level has arrived, so there is no gap
  between far and near.
- The overview is always there underneath. Every overview vertex carries its square number (0–15),
  and a 16-bit uniform hides the blocks of every square that has its own geometry loaded. That is
  one draw call per 2 km, and an exact hand-over per square.
- The overview ground sits 40 cm below the square ground, so it never shows through.
- **Next:** cross-fade between levels with a dithered alpha over about 0.3 s to soften popping.

## 9. Caching and memory

- In memory: only the wanted squares are kept. Leaving the range disposes their geometry, textures
  and materials immediately, and hysteresis prevents load/unload flapping at the edge.
- Persistent: the loader workers keep every file in Cache Storage, named after the region's build
  stamp. A new bake gets a new cache and old ones are deleted. At most 1,500 files are kept, oldest
  first. A revisited area loads in about 1 s instead of about 9 s on the simulated mobile connection.
  The cache is off on the local dev server unless you add `?cache=1`, because squares are rebaked
  one at a time there.
- CDN: immutable files per build (see 4).
- **Next:** under memory pressure (`performance.memory` where available, or a triangle budget),
  shrink the near range first.

## 10. Rendering techniques in use

- One merged mesh per material per square. The whole view measured 240–285 draw calls.
- InstancedMesh for trees, lamps, furniture and parked cars. Cars switch between 30k, 5k and box
  versions by distance.
- Quantised Uint16 positions and Int8 normals: about a third of the size of float32.
- Frustum culling per square group. Shadows only near the player.

## 11. Technologies compared

| Option | Verdict | Why |
|---|---|---|
| Custom quantised binaries (current) | **keep** | Smallest possible parse cost: the worker gunzips and hands the GPU typed arrays. They carry our own extras (instances, collision grid, labels) with no format bending. |
| meshoptimizer | **adopt next** | Its vertex/index codecs on top of the current quantisation typically shrink geometry another 30–50 % compared with gzip alone, and the WASM decoder runs in the existing worker. Its simplifier could also replace the hand-written block merging for the 8 km level. |
| glTF / GLB + glTF Transform | **use for authored assets** | Already used for the cars and the person (Blender to GLB). For tiles it adds parsing and a scene graph that brings no benefit. |
| three.js `LOD` | **not needed** | It switches per object every frame. Our switching is per square, done by the streamer, which also knows what has loaded. |
| Cesium 3D Tiles | **reference, not format** | Its implicit quadtree tiling with availability bitstreams is the model for the country-scale index above, and screen-space error is a good next criterion instead of fixed distances. Adopting the format (with 3d-tiles-renderer for three.js) would mean ECEF coordinates, glTF per tile, and moving instances and collision into extensions. Reconsider if we ever want to consume someone else's published 3D Tiles directly. |

## Size estimate for the whole country

Barendrecht averages about 1.6 MB per 500 m square at near level (geometry plus 25 cm aerial), 0.2 MB
at far level, and 0.14 MB per km² for the overview. Assuming roughly 5,000–6,000 km² of
built-up land in the Netherlands (a rough figure, not checked), that is about 24,000 squares: about 40 GB at today's detail, most of it aerial photos. That is
fine for object storage and a CDN, and a player only ever downloads the squares they pass.
WebP or AVIF aerials and meshopt geometry would roughly halve it.
