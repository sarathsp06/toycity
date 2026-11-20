// Every multiplayer distance and rate in one place (metres, seconds). Visibility and voice are
// separate on purpose: seeing someone never opens a voice connection.
export const MP = {
  appId: 'toycity-nl',            // namespace on the Nostr relays
  // public Nostr relays used only to find each other; every player must use the same list.
  // Checked on 2026-11-20: these accept anonymous short-lived events; damus.io, oldenburg.cool and
  // others were down or refused. Fewer relays also means fewer duplicate connection offers.
  relays: ['wss://relay.primal.net', 'wss://nostr.data.haus', 'wss://nos.lol', 'wss://nostr.sathoarder.com', 'wss://yabu.me/v2'],
  iceUrl: 'https://toycity-turn.sarathsp.workers.dev/',   // STUN + TURN credentials (Cloudflare)
  roomSize: 500,                  // one room per 500 m square of the RD grid
  roomJoinEdge: 20,               // also join the neighbouring square when this close to its edge
  roomLeaveEdge: 40,              // and leave it again only when this far away
  sendHz: 10,                     // position updates while moving
  idleHz: 1,                      // and while standing still
  showWithin: 60,                 // other players appear inside this distance (10 m hid friends a street away)
  hideBeyond: 70,                 // and disappear beyond this one (no flicker at the edge)
  interpDelay: 0.15,              // remote players are drawn this far in the past, for smoothness
  peerTimeout: 5,                 // forget a player not heard from for this long
  // voice reaches as far as you can see someone: 3 m (the first version) was silent before you
  // were close enough to notice anyone, especially with the camera behind you
  voiceConnect: 10,               // start sending my microphone to a player inside this distance
  voiceDisconnect: 12,            // stop beyond this distance ...
  voiceLinger: 3,                 // ... after this many seconds out of range
  voiceFull: 2,                   // full volume inside this distance
  voiceSilent: 10,                // fades to nothing here
};
