// Every multiplayer distance and rate in one place (metres, seconds). Visibility and voice are
// separate on purpose: seeing someone never opens a voice connection.
export const MP = {
  appId: 'toycity-nl',            // namespace on the Nostr relays
  // public Nostr relays used only to find each other; every player must use the same list.
  // Picked for accepting anonymous short-lived events (two others refused us on 2026-11-20).
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.data.haus', 'wss://relay.oldenburg.cool', 'wss://yabu.me/v2'],
  iceUrl: 'https://toycity-turn.sarathsp.workers.dev/',   // STUN + TURN credentials (Cloudflare)
  roomSize: 500,                  // one room per 500 m square of the RD grid
  roomJoinEdge: 20,               // also join the neighbouring square when this close to its edge
  roomLeaveEdge: 40,              // and leave it again only when this far away
  sendHz: 10,                     // position updates while moving
  idleHz: 1,                      // and while standing still
  showWithin: 10,                 // other players appear inside this distance
  hideBeyond: 12,                 // and disappear beyond this one (no flicker at the edge)
  interpDelay: 0.15,              // remote players are drawn this far in the past, for smoothness
  peerTimeout: 5,                 // forget a player not heard from for this long
  voiceConnect: 4,                // start sending my microphone to a player inside this distance
  voiceDisconnect: 6,             // stop beyond this distance ...
  voiceLinger: 3,                 // ... after this many seconds out of range
  voiceFull: 1,                   // full volume inside this distance
  voiceSilent: 3,                 // fades to nothing here
};
