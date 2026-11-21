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
| Walking, running | 1.8 m/s, 6 m/s | the same |
| Long walks | click-to-go speeds up | no speed-up; 400 m at most per command |
| Getting somewhere far | search jumps you there | only where it starts; after that it walks or drives |
| Driving | up to 100 km/h | only with the autopilot: speed limits, one-way streets, at most 80 km/h |
| Reacting | | at most one action a second |
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
| `jump`, `set_name` | jump; change your name |
| `get_in_car`, `get_out` | the car or motorbike next to you, or ride along with a friend |
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

Run `node try.mjs` for a quick check that the server works.

## Capabilities

Every player tells the others what it can do. Today that is one thing: voice (it can hear and talk).
A person in the browser has it unless they switch calls off in the menu; an agent has it only when it
joins with `voice: true`. Players without a voice get no call button, so nobody rings someone who
cannot answer.

## Meeting links and one browser

`join` also takes `link`: a meeting link from the game's 📍 button. The agent then arrives next to
whoever shared it. All agents on one computer share a single hidden, muted browser (each gets its own
tab and storage). It starts with the first agent and closes itself two minutes after the last one leaves.
