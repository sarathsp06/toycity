# The room while on a call: performance

2026-11-25. Goal: inside a house, on a voice call, the page spends almost nothing on the town outside.
Measured with a headless Chromium on the real GPU (Apple M3 Pro, Metal), at Schaatsbaan 43 in
Barendrecht, 8 s per row, main-thread milliseconds per frame. `window.__city.stats` now carries
`work` (the game's own code), `draw` (three.js walking the scene and issuing draw calls) and `worst`
(the slowest frame in the last half second), so anyone can repeat this.

What changed for certain (the same in every run):

| indoors | before | after |
|---|---|---|
| draw calls | 84 | 45 |
| triangles | 0.21 M | 0.11 M |
| shader re-derivation every frame | yes | no |

So the GPU does half the work in the room, which is what matters on a phone. The millisecond
timings vary a lot between runs of the same code on this laptop, so they are ranges:

| indoors, ms per frame | before | after |
|---|---|---|
| game work | 0.49 | 0.12 to 0.30 |
| drawing | 3.0 | 0.8 to 2.8 |

Every run held 60 fps before and after. Hiding the town and switching off its matrix updates showed
no drawing change that stands out of that noise; the lower game work comes from pausing the town's
simulation. Outdoors nothing changed (about 370 draw calls, 3.1 M triangles).

## Done

1. **The wall clock's glass made three.js draw the room twice.** One Poly Haven material had glass
   transmission, so every frame three.js rendered the whole opaque room again into an offscreen
   target and switched every shader between the two passes. `interior.js` drops transmission at load
   (the glass is rough and already 40 % transparent, so it looks the same). 84 to 45 draw calls.
2. **The town hangs on one group**, hidden indoors with its matrix updates switched off
   (`town` in `city.js`). Squares, overview, doors, parked and moving cars, people, birds and the
   route line go there; the room, you, the other players and the lights stay on the scene.
3. **The town waits while you are inside**: no square uploads (decoded squares queue until you are
   out), no streaming, no traffic, passers-by, birds, signs or route updates, no shadow checks.
   Traffic and passers-by are a function of the clock, so they are in place again when you step out.
4. **The room and the people download at half the size.** `tools/build_site.sh` compresses the
   room, the person, the personas and the animations with meshoptimizer (`gltf-transform meshopt
   --level medium`, positions quantised well under a millimetre); `web/gltf.js` gives every loader
   three.js's WebAssembly meshopt decoder. Entering a house costs 2.5 MB instead of 3.9 MB; those four
   kinds of file together 4.8 MB instead of 9.3 MB. Checked: the room and a seated person render the
   same as uncompressed. The files in `web/models` stay uncompressed, because the Blender and
   retargeting tools read them back; compressing needs `npm install` in `tools/` first.
   **Not the cars**: quantising moves each mesh's scale and offset into its node, and a car door's
   node position is its hinge (`openParts` in `city.js`), so the doors would swing about the wrong
   point. Compressing `cars.glb` (5.85 to 1.9 MB) needs the hinges stored apart from the nodes first.
   `floatGeometry` already makes the car builder safe for quantised geometry.

## Not done, and why

- **Baking the room's light into a lightmap.** It would make each pixel cheaper, but there is no
  sign the room is GPU-bound now (60 fps with 45 draw calls on a laptop). Worth measuring on a phone
  first. It is Blender work in `tools/interior_model.py` plus a lightmap on the room's materials.
- **Animating seated people less often.** Two skeletons cost about 0.2 ms a frame here; a full house
  of nine might make it worth animating seated people at 20 Hz, as `peds.js` already does far away.
- **Voice meters in an audio worklet.** Each person's level is a 512-sample RMS per frame, a few
  microseconds; not worth the risk.
- **Rust or WebAssembly beyond meshoptimizer.** The square loader already uses the browser's native
  gzip and image decoding and hands the quantised arrays to the GPU untouched: there is nothing left
  for Rust there. Path-finding and the town's simulation cost well under a millisecond. The one place
  Rust would pay is the offline bake (`tools/buildtiles.mjs`), for build time only.
- **meshoptimizer for the 500 m squares.** Their geometry is already quantised and gzipped by
  `buildtiles.mjs`; meshopt's codec would shrink them further (30 to 50 % by its authors' figures)
  but needs a rebake of every region. A separate job.
