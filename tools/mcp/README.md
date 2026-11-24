# Toy City MCP: let your AI agent join the map

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent a body in
[Toy City](https://toycity.pages.dev). The agent is a real player: people in the game see it walking
around with a 🤖 in front of its name, it can drive, knock on doors and live in a house, and it meets
whoever is there.

## Fair play

An agent never gets to do more than a person could. That is checked by the server and the game, so it
does not depend on the agent behaving:

| | A person | An agent |
|---|---|---|
| Walking, running | 1.8 m/s, 6 m/s (in a house 1.3, 3.5) | the same |
| Long walks | click-to-go speeds up | no speed-up; 400 m at most per command |
| Getting somewhere far | search jumps you there | only where it starts; after that it walks or drives |
| Driving | up to 100 km/h | only with the autopilot: speed limits, one-way streets, at most 80 km/h |
| Reacting | | at most one move a second (talking isn't held back) |
| What it knows | what is on screen | what is around it (people within 60 m, the next door, a car in reach) |

It is marked 🤖 so nobody mistakes it for a person. On the autopilot a car passes through people instead
of running them over, so an agent can't knock anyone down.

## Set up

Needs Node.js 22+. It runs the game in a hidden Chromium-based browser: Chrome, Brave, Edge, Arc or Vivaldi if you have one, otherwise it downloads its own the first time (about 100 MB). From this folder:

```sh
npm install
```

Then add it to your MCP client. Claude Code:

```sh
claude mcp add toycity -- node /path/to/toycity/tools/mcp/server.mjs
```

oh-my-pi (`omp`): add under `mcpServers` in `~/.omp/agent/mcp.json`:

```json
"toycity": { "command": "node", "args": ["/path/to/toycity/tools/mcp/server.mjs"] }
```

Claude Desktop, Cursor and others (`mcpServers` in their config):

```json
{ "toycity": { "command": "node", "args": ["/path/to/toycity/tools/mcp/server.mjs"] } }
```

Settings, as environment variables: `TOYCITY_CHROME` (the browser, if it isn't found by itself) and
`TOYCITY_URL` (another copy of the game, e.g. `http://localhost:8765/` while developing).

## Tools

| Tool | What it does |
|---|---|
| `join` | enter a town (Rotterdam, Barendrecht or Amsterdam), optionally next to an address, with a name, and with or without a voice |
| `look` | where you are, people nearby (distance and compass bearing, whether they can talk), the nearest front door (address, distance, bearing), a car in reach, calls and knocks |
| `where` | coordinates and a meeting link for your spot, or a player's |
| `see` | a picture of the view |
| `walk_to` | walk or run to an address, place or street, along the footpaths (an address: to its front door), or to where a player is |
| `walk` | a few metres in a compass direction |
| `follow` | walk behind a player, round corners, until `stop` |
| `wait` | let up to 30 s pass, then look; returns early on arrival, or on what you wait `for`: speech, a knock, a call, a person near |
| `stop` | stop walking, following or driving |
| `sit` / `stand_up` | inside a house: walk round the furniture to the nearest free seat in the lounge (sofa or armchair) and sit down; get up again |
| `jump`, `set_name` | jump; change your name |
| `get_in_car`, `get_out` | the car or motorbike next to you, or ride along with a friend (if they get out, you stay in their parked car until you get out) |
| `radio` | in a car, also as a passenger: on, off, next station, volume |
| `drive_to` | the autopilot drives you there |
| `knock`, `live_here`, `go_inside`, `step_outside`, `answer_door` | doors and homes |
| `call`, `say`, `listen`, `mute`, `hang_up` | only when joined with `voice: true`: ring someone who can talk (and learn whether they answered), speak and hear the reply in one step (`say` with `then_listen`, the default), or `listen` (returns as soon as they finish a sentence); words come from [whisper.cpp](https://github.com/ggml-org/whisper.cpp): `brew install whisper-cpp` and a ggml model in `~/.cache/whisper` or `TOYCITY_WHISPER_MODEL`. Calls to you are answered by themselves |
| `leave` | leave the game |

## Voice

An agent with `voice: true` speaks with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), a natural
neural voice that runs offline, when it is on this computer: the copy HyperFrames installs in
`~/.cache/hyperframes` is found by itself, or set `TOYCITY_KOKORO_PYTHON` (a Python with `kokoro-onnx` and
`soundfile`), `TOYCITY_KOKORO_MODEL` and `TOYCITY_KOKORO_VOICES`. Pick a voice with `join({ voice_name })`
or `TOYCITY_VOICE`: `af_heart` (default), `af_bella`, `af_nicole`, `am_michael`, `am_adam`, `bf_emma`,
`bm_george` and about fifty more. Without Kokoro it falls back to the computer's own voice.

A conversation is one tool call per turn: `say` speaks two or three sentences and then waits until you
have answered and finished your sentence, and returns your words. You can interrupt: talk over the
agent for half a second and it stops mid-sentence, hears what you said and answers that. Noises, a
cough, and its own voice coming back through your speakers do not stop it: it pauses, checks, and
carries on where it was. Answers are spoken sentence by sentence, so a long one starts quickly and
stops cleanly. Speech and hearing run beside the server, so an agent can keep walking while it talks.

Try it: "Join Barendrecht near Dorpsstraat 141 as Robin, walk to the church, and tell me who you meet."

Run `node try.mjs` for a quick check that the server works, and `node --test *.test.mjs` here for the unit tests.
With a whisper.cpp install that has `whisper-server` (Homebrew's does), the model is loaded once and
kept: words come back in well under a second. `TOYCITY_WHISPER_SERVER=0` uses `whisper-cli` per phrase
instead; `TOYCITY_DEBUG=1` logs turn timings to stderr.

## Capabilities

Every player tells the others what it can do. Today that is one thing: voice (it can hear and talk).
A person in the browser has it unless they switch calls off in the menu; an agent has it only when it
joins with `voice: true`. Players without a voice get no call button, so nobody rings someone who
cannot answer.

## Meeting links and one browser

`join` also takes `link`: a meeting link from the game's 📍 button. The agent then arrives next to
whoever shared it. All agents on one computer share a single hidden, muted browser (each gets its own
tab and storage). It starts with the first agent and closes itself two minutes after the last one leaves.

## How it is built

Four modules, each behind a small interface, so each can be tested and changed alone:

| Module | Interface | What it hides |
|---|---|---|
| `server.mjs` | the MCP tools | arguments, limits (`pace`: one move a second, walks of 400 m), wording |
| `session.mjs` | `Session`: `open`, `need`, `api(method, …)`, `close`; `pageBridge(page)` | the shared browser, the tab, its lease, recovery when the page dies |
| `../../web/agent.js` | `window.__agentApi` in the page | how the game is read and the body moved |
| `turn.mjs` | `createTurns({ bridge, tts, stt, clock })`: `say`, `hear`, `sayWav` | the conversation policy |
| `speech.mjs` | TTS `speak(text, voice) -> { wavB64, seconds }`; STT `transcribe(wavB64, hint) -> string[] \| null` | which engines run, and keeping them alive |

### Speech ports and adapters

- TTS: `kokoroTTS` (one resident Python worker, `kokoro-worker.py`; every request has an id and the
  reply echoes it, so a late reply can't answer the next request; 15 s per request), `systemTTS` (macOS
  `say`, `espeak-ng`), `chainTTS` (the first that works, per request), `fakeTTS` (tests).
- STT: `whisperServerSTT` (`whisper-server` on a private port, started at join, model kept loaded,
  `POST /inference`, 20 s timeout), `whisperCliSTT` (one process per phrase), `whisperSTT` (the server,
  else, or when it fails, the CLI), `fakeSTT` (tests). Not finding whisper is checked again after a
  minute rather than remembered for good. The Silero VAD model is downloaded once, with a 20 s timeout.
- Supervision: a worker that exits, or doesn't answer in time (it is then killed), is started again on
  the next request after a backoff of 1, 2, 4 … 60 s; a success resets it. Leaving stops both.

### Turn policy (`turn.mjs`)

- `say` splits the text into sentences (`sentences`): sentence 1 is being synthesized before anything
  else is awaited, and the next two while earlier ones play. Each clip goes out with one
  `page.evaluate` that also checks the call is still on.
- Echo: what I said in the last 30 s, including the sentence playing now, is remembered; a heard phrase
  that is mostly those words (3+ shared content words, 60 %+) is my own voice coming back (`notMine`).
  Whisper's descriptions of sounds and the phrases it makes up from silence (`MADE_UP`) are dropped.
- Barge-in: the page stops me after half a second of sound over my voice. That is only a suspicion:
  their turn is then heard to its end as in `listen`, and counts as an interruption with a stop word
  (`CUES`) or 3+ words. Otherwise I carry on 0.4 s before where I stopped; after three false alarms in
  one `say`, barge-in is off for the rest of it (a noisy room).
- End of their turn (`hear`): after 400 ms of quiet the audio so far is taken and transcribed while the
  page keeps listening; the words then set how long the quiet must last (`quietWindow`): a question
  400 ms, a finished sentence 750 ms, a sentence left hanging ("and", "the", a comma) 1.2 s. If they go
  on, everything is heard again as one recording. Waits run inside the page (checked every 30 ms), not
  as polls from here.

### Latency (`test-voice.mjs`, local, Kokoro + whisper small.en; seconds after the person stopped)

| | before | after |
|---|---|---|
| `listen` returns their question | 1.9 | 0.8 |
| interruption verdict ("Stop, stop … instead.") | 1.7 | 0.8 |
| `say` returns their reply ("… Goodbye.") | 1.9 | 0.8 |

Where it went: whisper-cli loaded the model for every phrase (~5 s cold, ~0.5–1.5 s warm); the
resident server answers in ~0.4 s, and that now overlaps the quiet window instead of following a fixed
1.1 s one. `say` no longer waits for the one-move-a-second gap (up to 1 s), and the call check and the
first take are one round trip. What remains per turn is the agent's own thinking plus ~0.3–0.6 s for
Kokoro to make the first sentence.

### Supervision and recovery

The session listens for the page crashing or closing and for the shared browser going away. It then
forgets the page (and the conversation memory) and releases its lease, and every tool answers "The
game page crashed; use join again." instead of failing on a dead page. Walking and following run inside
the page, so they end with it; `leave` stops them and the speech workers.

### In-page agent adapter (`web/agent.js`)

Loaded after the game is up (`page.addScriptTag`, from the site, or this checkout's copy when the site
doesn't serve it yet). It installs `window.__agentApi`: `snapshot()` (what `look` shows: me, people in
sight with name, what they are doing, `can_talk` from the game's own `__agentCall.canTalk`, distance and
bearing, the door, the car, calls, knocks), `walkPlace`, `walk`, `stop`, `follow` / `stopFollow` (the
trail-following loop), `waitFor(event, ms)`, `toDoor`, `knock`, `liveHere`, `answerDoor`, `homeMove`,
`getIn`, `rideWith`, `getOut`, `driveTo`, `where`, `names`. It moves the body only through the game's
`window.__agent` (human speeds) and takes pose numbers from `web/mp/state.js` when the game has it.
