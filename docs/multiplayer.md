# Multiplayer: seeing and hearing each other

Status 2026-11-20: built and tested with two browser tabs. There is no server of our own: the site is still only static files.

## Three independent systems

| System | Code | Knows about |
|---|---|---|
| Geographic streaming | `web/city.js` | buildings, roads and terrain. Nothing about other players. |
| Multiplayer presence | `web/mp/presence.js`, `players.js` | who is around, positions, names and avatars. Nothing about audio or the map. |
| Spatial audio | `web/mp/voice.js` (voice), `web/mp/ambience.js` (environment) | microphone, proximity and positioning. Peers come through presence, and audio goes through a swappable transport. |

`web/mp/index.js` wires them together and draws the buttons. `city.js` only calls `start()` and `update()`, which is about 25 lines including the helper that reports surroundings. `city.html?mp=0` turns the whole layer off.

All distances and rates are in `web/mp/config.js`.

## How players find each other (no backend)

1. The map is divided into **rooms** of 500 m squares on the Dutch RD grid. You join the square you're in. You also join a neighbouring square when you're within 20 m of its edge, and leave it again past 40 m. That way you can always see someone standing across the line.
2. Joining a room means announcing yourself on **public Nostr relays**, through the Trystero library. The relays are a meeting point only. They pass along the WebRTC offer and answer between two browsers, then they're out of the picture. The relay list is fixed in `config.js`, because everyone has to use the same relays to find each other. On 2026-11-20 several relays from the library's default list were down or refused anonymous visitors, so the list holds five that worked.

   Trystero is bundled locally (`web/mp/trystero-nostr.js`) with a small patch (`tools/trystero.patch`). Stock Trystero discards its connection offer about 4.8 s after making it. A connection that has to go through the TURN relay gathers its relay addresses for up to 5 s before answering, so the answer always arrived too late and phone-to-computer players never met. The patch keeps offers for 20 s and pre-builds 2 offers instead of 20.
3. From then on, everything travels **directly between browsers** over a WebRTC connection: positions over a data channel, and voice as an audio track on the same connection.

## Presence

- **State:** `[seq, RD x, RD y, heading, speed, name]`. It's sent 10 times a second while moving, once a second while standing still, and immediately after a name change or when someone joins.
- **Smoothing:** other players are drawn 150 ms in the past, between the two samples on either side of that moment. Late or duplicate samples (an older sequence number) are dropped.
- **Visibility:** players appear within 10 m and disappear beyond 12 m. The rule is one function in `logic.js`, so a camera-view test can replace it later.
- **Leaving:** a player is removed when the room says they've gone, or after 5 seconds without an update. That cleans up their avatar and their voice.
- **Avatars:** a copy of our own person, with a shirt colour taken from the player's id and their name above their head. Idle, walk and run animations are blended by speed.
- **Names:** click your name in the panel to edit it in place. It's saved in the browser and sent with every update.

## Voice

- **Off by default.** The microphone button asks for permission. Echo cancellation, noise suppression and automatic gain are all on.
- **Seeing someone never sends audio.** I send my microphone to a player once they're within **4 m**. I stop when they've been beyond **6 m** for **3 s**, so walking back and forth across the boundary doesn't reconnect. Receiving uses the same rule.
- **Volume:** a Three.js `PositionalAudio` attached to the speaker's avatar. Full volume up to 2 m, fading linearly to silent at 10 m (about as far as you can see someone), with HRTF panning so you can hear which side someone is on. The listener moves with the camera.
- There is **one connection per pair of players** and no separate voice link. The stream is added to the existing connection, always through the same room. Each microphone is sent raw, and mixing happens only in the listener's browser.
- **Talking indicator:** a ring under the speaker's feet lights up with their loudness. My own microphone button fills with my level.
- **Chrome quirk:** WebRTC audio only reaches Web Audio if the stream also feeds a muted `<audio>` element. A stream can also arrive a moment before its track does, so the code waits for the track.

### Connection lifecycle

```
A and B in the same room (Nostr) ─► WebRTC offer/answer through the relays ─► data channel open
  ─► state messages both ways (10 per second / 1 per second)
B comes within 10 m and A's mic is on ─► A: addStream(mic, B) ─► renegotiation on the same connection
  ─► B: onPeerStream ─► PositionalAudio on A's avatar
B beyond 12 m for 3 s ─► A: removeStream ─► B: drops the audio when the track ends
B leaves the room, closes the tab or is silent for 5 s ─► avatar and audio removed, connection closed
```

## Background sounds

Made in the browser from noise and oscillators, with no files and no network:
- wind (gusting band of noise), always
- rustling leaves, more with more trees within 40 m
- bird chirps, more often where it's green
- low traffic rumble, louder near streets with many parked cars within 60 m

It starts with the first click (browsers require that) and has its own on/off button.

## Swapping in an SFU (for example LiveKit) later

Voice only talks to a transport with three functions: `send(peer, stream)`, `stop(peer, stream)` and `onStream(f)`. An SFU transport would publish the microphone once and subscribe to nearby speakers by id, while presence and the range rules stay exactly as they are.

What that needs, which is why it isn't done now:
- a small token service, because LiveKit room tokens are signed with a secret that can't live in a static site
- either a LiveKit Cloud project or a self-hosted server

Worth it once more than about 15–20 people gather in the same 500 m square, or for players whose networks block direct connections.

## Limits of the current version

- Everyone in a room connects to everyone else in it. That's fine for small groups, but it won't scale to crowds.
- About 1 in 10 networks block direct connections. Those players connect through Cloudflare's TURN relay instead (credentials from the `toycity-turn` Worker), which is slower to set up, so meeting someone can take up to half a minute.
- The public relays are run by other people and can be slow or go down. Six are used in parallel.
- Positions aren't checked by anyone, and mute and block are local only. Players connected directly can see each other's IP addresses.
- Jumps aren't shared yet. Other players stay on the ground.

## Testing

- `node --test tests/*.test.mjs` runs 9 tests: rooms and their hysteresis, smoothing including late and duplicate updates, heading wrap-around, the voice range rules including someone walking back and forth across the boundary, visibility hysteresis, the volume curve, and name cleaning.
- End to end: open `city.html?fakemic=1` in two tabs. `fakemic` uses a beeping tone instead of a real microphone. Each tab sees the other, hears its tone, and loses it again after walking 9 m away.
