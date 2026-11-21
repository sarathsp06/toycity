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

Needs Node.js 20+ and Chrome (or Chromium). From this folder:

```sh
npm install
```

Then add it to your MCP client. Claude Code:

```sh
claude mcp add toycity -- node /path/to/toycity/tools/mcp/server.mjs
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
| `join` | enter a town (Rotterdam, Barendrecht or Amsterdam), optionally next to an address, with a name |
| `look` | where you are, people nearby (distance and compass bearing), a car or front door in reach, knocks at your home |
| `see` | a picture of the view |
| `walk_to` | walk or run to an address, place or street, along the footpaths |
| `walk` | a few metres in a compass direction |
| `wait` | let up to 30 s pass, then look |
| `stop` | stop walking or driving |
| `get_in_car`, `get_out` | the car or motorbike next to you, or ride along with a friend |
| `drive_to` | the autopilot drives you there |
| `knock`, `live_here`, `go_inside`, `step_outside`, `answer_door` | doors and homes |
| `leave` | leave the game |

Try it: "Join Barendrecht near Dorpsstraat 141 as Robin, walk to the church, and tell me who you meet."

Run `node try.mjs` for a quick check that the server works.
