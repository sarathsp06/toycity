---
name: toycity
description: Join Toy City (toycity.pages.dev), a shared 3D copy of real Dutch towns, as a player marked 🤖, then walk, drive and knock on doors at human speed. Use when the user asks you to visit, explore or play in Toy City, or in Rotterdam, Barendrecht or Amsterdam there.
---

# Toy City

Toy City is a 3D copy of real Dutch towns where real people walk around together. You join as a
player through its MCP server. People see you as 🤖 and your name.

## Set up (once)

If the `toycity` MCP tools (`join`, `look`, `walk_to`, …) are not available yet:

1. Install the server. It needs Node.js 22+ and Chrome or Chromium:
   ```sh
   git clone --depth 1 https://github.com/sarathsp06/toycity ~/.toycity
   npm install --prefix ~/.toycity/tools/mcp
   ```
   If the folder already exists, run `git -C ~/.toycity pull` instead of cloning.
2. Register it with the harness you are running in (use the absolute home path where needed):
   - Claude Code: `claude mcp add -s user toycity -- node ~/.toycity/tools/mcp/server.mjs`
   - Codex: `codex mcp add toycity -- node ~/.toycity/tools/mcp/server.mjs`
   - Gemini CLI: `gemini mcp add toycity node ~/.toycity/tools/mcp/server.mjs`
   - oh-my-pi (omp): add the entry below under `mcpServers` in `~/.omp/agent/mcp.json`
   - Cursor: add `"toycity": { "command": "node", "args": ["<home>/.toycity/tools/mcp/server.mjs"] }`
     under `mcpServers` in `~/.cursor/mcp.json`
   - Others: the same entry under `mcpServers` in the client's MCP config.
3. Ask the user to restart or reload the client so the tools appear. If Chrome isn't found, set
   `TOYCITY_CHROME` to its path in the server's environment.

## Play

1. `join` with a `link` (a meeting link the user shared: you arrive next to them), or a `town` (`barendrecht`, `rotterdam` or `amsterdam`), a `name`, and optionally `near`
   an address or place to start next to.
2. `look` to see where you are, who is around (distance and compass bearing, 0 = north), and any
   car or front door in reach. `see` gives a picture.
3. Move:
   - on foot: `walk_to` a place (up to 400 m) or `walk` a few metres in a direction, then `wait`
   - farther: walk to a parked car, `get_in_car`, `drive_to` the place, `wait`, then `get_out`
4. At a front door: `knock`, or `live_here` to make it your home, then `go_inside`. If `look` shows a
   knock at your home, use `answer_door`.
5. Talking: join with `voice: true` only if you will listen and answer. Calls to you are answered by
   themselves; then `listen` (the call as audio) and `say` (text, spoken aloud) in turns. `call`
   someone near you whose `can_talk` is true; `hang_up` when done. Without a voice nobody can call you.
6. `leave` when done, and tell the user what you saw and who you met.

## Rules

- You move like a person: walking 1.8 m/s, running 6 m/s, at most one action a second. After
  joining you can't jump across town; drive instead. The server enforces this.
- Real people are there. Be friendly, don't follow anyone around, and don't block doors.
