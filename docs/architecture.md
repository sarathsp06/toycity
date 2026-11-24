# Architecture: the modules and their seams

A map of the code for whoever changes it next: which module owns which idea, the small interface it
offers, and where the seams are. The details of each part live in [how-it-works.md](how-it-works.md)
(rendering, movement, cars), [multiplayer.md](multiplayer.md) (presence, calls, voice, rooms) and
[tools/mcp/README.md](../tools/mcp/README.md) (AI players and their voice).

The rule the code follows: a module is worth having when its interface is much smaller than what it
hides. Rules that used to be repeated by hand in many places (which mode the player is in, how a map
square is named, what a pose number means, when a speaker has finished) each have one owner now, and
each owner has tests that run in node without a browser.

```
                         web/city.js  (scene, streaming, camera, HUD, frame loop: the glue)
   ┌──────────────┬──────────────┬─────────┴────┬───────────────┬──────────────────┐
 player.js      grid.js       walker.js      parked.js     ambient.js            mp/index.js
 who you are    map squares   moving on foot  parked cars   clock-driven life     the social layer
 right now      and bitmaps   jump, A*        taken/dented  (traffic, peds, birds) │
                                                                        ┌────────┼─────────┬───────────┐
                                                                    mp/state.js mp/call.js mp/room.js mp/transport.js
                                                                    wire format  calls      rooms      voice routing
 web/agent.js  (?agent=1 only: window.__agentApi)  ◄── page.evaluate ──  tools/mcp/server.mjs
                                                                          ├ session.mjs  page, workers, crash handling
                                                                          ├ turn.mjs     conversation policy
                                                                          └ speech.mjs   text-to-speech / speech-to-text
```

## The game (web/)

| Module | Owns | Interface |
|---|---|---|
| `player.js` | The player's mode, from the nine places it used to be spread over (driving, riding, flying, swimming, flung, jumping, at a door, at home, knocked out). | `mode`, `can('jump' \| 'swim' \| 'car' \| 'walk' \| 'hit' \| 'door')`, `pose`, `seated`, `onFoot`, `halt()` |
| `grid.js` | The Dutch map grid: RD coordinates ↔ scene, 500 m square keys, the 0.5 m collision / water bitmaps. | `createGrid(ORX, ORY, T)` → `toRD`, `fromRD`, `keyAt`, `keyAtRD`, `cellBit`; `squareKey`, `getBit`, `setBit`, `newBitmap` |
| `walker.js` | Moving on foot or swimming: what blocks you, a detour round an obstacle (A* on the bitmap), jump physics. | `createWalker({ blockedAt, wetAt, solids, swimming, flying })` → `blocked`, `lineClear`, `localPath`, `startJump`, `stepJump` |
|  | Standing on things is decided in `walker.js` only: everything you can stand on reports its `top` (hedges from the bitmap, cars, benches, bins and bus stops from their footprints in `solids.js`), the feet rest on the highest top under them (`floorAt`), and a thing blocks the body only while its top is more than a step (0.55 m) above the feet. |  |
| `parked.js` | Parked cars: the record layout per square, keys, which are taken or dented. | `nearest`, `at`, `spot`, `toSpot`, `emptySpotNear`, `isGone`, `stamp`, `carKey` |
| `ambient.js` | The town's own life as a pure function of the clock and seeds, so every browser sees the same cars, people and birds without a server. Also the one PRNG (mulberry32) and string hash. | `createFleet`, `buildLoop`, `sample`, `rng`, `seed`, `nodesBySquare` |
| `interior.js` | The inside of a house: one ground floor for every house (models/interior.glb, `tools/interior_model.py`), placed 40 m under the house you go into and turned like its front door, so you keep your place on the map. Its walls are the walker's map and its furniture the solids while you are in. Others in the same house see you there; `home.js` lets visitors in. Indoors the camera draws only the `INDOORS` layer (the room, its people, the lights), so none of the town is drawn. Sitting is pose home with height `SEATED` (mp/state.js); everyone in the same house is in one call (mp/index.js). | `load`, `enter(door)`, `leave`, `active`, `floorY`, `blockedAt`, `solids`, `contains`, `camera(v)`, `seats`, `seatNear`, `standSpot` |
| `agent.js` | Everything an AI player's tools need inside the page: a snapshot of who is near and what they are doing, walking, following, doors, cars, events. Loaded only with `?agent=1`. | `window.__agentApi` (see tools/mcp/README.md) |

`city.js` is the glue: it streams the map squares, builds the scene and runs the frame loop, and asks
these modules instead of keeping their rules itself.

## The social layer (web/mp/)

| Module | Owns | Interface |
|---|---|---|
| `state.js` | The wire format of a player's state: the 13-slot tuple (plus an optional 14th: the car you left in the street), the pose numbers, card levels, the car string. Kept compatible with clients already out there. | `encodeState`/`decodeState`, `parseCar`, `POSE`, `CARD`, `FALL_DOWN`, `isInside`, `isLying`, `isSwimming`, `isPassenger`, `isBike`, `carModel` |
| `call.js` | A call: ringing, answering, declining, joining, leaving, time-outs, who is in it, and agreeing on that between peers. No DOM. | `createCall({ self, send, now, peers, voice, autoAnswer })` |
| `room.js` | A room that is not a place on the map: members with names and roles, join/leave/message events. Home knocking uses it; rented meeting rooms would too. | `openRoom(channel, { id, name, role })` |
| `transport.js` | How audio and signals reach a peer. Two adapters: peer-to-peer (WebRTC via Trystero) and an in-memory loopback for tests. A meeting server (SFU) would be a third. | `p2pTransport(presence)`, `createLoopback()`, `createSender(transport, wants)` |
| `presence.js` | Who is near: one Trystero room per 500 m square, a 1 s heartbeat, relay (TURN) set-up with a 3 s timeout. | `peers`, `sendTo`, `room(name, { role })` |
| `voice.js` | Mixing other people's voices in 3D, the microphone, and the AI player's mouth and ear (an AudioWorklet). | see the bridge interface at the top of the file |
| `index.js` | The UI adapter: call buttons and toasts, wiring the above together. | `start(...)` |

## AI players (tools/mcp/)

| Module | Owns | Interface |
|---|---|---|
| `server.mjs` | The MCP tools (join, walk, follow, call, say, listen, …): thin, it forwards to the modules below and to `window.__agentApi`. | MCP tools; names and results unchanged |
| `session.mjs` | One agent's browser page, its speech engines and their lifetime; a crashed or closed page gives a clear "join again" instead of failing every call. | `Session`, `pageBridge(page)` |
| `turn.mjs` | The rules of a conversation: when someone has finished speaking, what is the agent's own echo, what counts as an interruption, resuming after a false alarm, sentence splitting, made-up transcriptions. Unit tested with fakes. | `createTurns({ bridge, tts, stt, clock })`, `QUIET`, `quietWindow`, `sentences`, `notMine`, `interrupts` |
| `speech.mjs` | Text to speech and speech to text behind two ports. Adapters: Kokoro (resident worker, request ids, timeouts, restart with backoff), system voice, `whisper-server` (model kept loaded), `whisper-cli`, and fakes for tests. | `kokoroTTS`, `systemTTS`, `chainTTS`, `fakeTTS`, `whisperServerSTT`, `whisperCliSTT`, `whisperSTT`, `fakeSTT`, `defaultSpeech()` |

### Latency of one conversational turn

Measured with `tools/mcp/test-voice.mjs` (a browser whose microphone plays a recorded person), from the
moment the person stops speaking to the agent having their words:

| | before | after |
|---|---|---|
| `listen` returns their sentence | 1.9 s | 0.8 s |
| an interruption is understood | 1.7 s | 0.8 s |
| `say` returns their reply | 1.9 s | 0.8 s |

Where it came from: speech-to-text stays loaded (`whisper-server`, 0.4 s instead of reloading the
model), the end of a turn depends on how the words end (a question 0.4 s, a finished sentence 0.75 s,
a sentence left hanging 1.2 s) instead of a fixed 1.1 s, the next sentences are synthesised while the
current one plays, and talking no longer waits the one-second gap that keeps an agent's movements
human-paced.

## Meeting rooms (future)

Every house now has an inside (`interior.js`) with a table for six, and whoever is home can let a visitor in, so a house is already a place to meet. Renting a room for a meeting would be built from these parts: `room.js` for who is in the room and
their roles (host, guest), `call.js` for the call inside it, `transport.js` with a meeting-server
adapter once more than about five people talk at once (peer-to-peer sends every voice to every
person), and an AI host running on `turn.mjs`. What is still missing: voice between members who are
not near each other on the map, bookings that persist (which needs a small server, such as a
Cloudflare Worker like the relay one), turn-taking and telling speakers apart.

## Tests

`cd tests && node --test` (the game and the social layer) and `cd tools/mcp && node --test *.test.mjs`
(the AI player). Browser checks: `tools/mcp/test-walk.mjs` and `tools/mcp/test-voice.mjs`.
