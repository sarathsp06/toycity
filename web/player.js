// What the player is doing right now, asked in one place. The state stays where it lives (the car in
// vehicle.js, the front door and home in home.js, the swim, the jump, being knocked over and health in
// city.js); this module only answers questions about it, so "may I jump now?" gets the same answer
// from the Space key, the touch button and an agent.
//
//   const player = createPlayerMode(src, { stopWalk })
//     src: { driving, ride, fly, swim, fling, jump, homes, health }, read through getters (some are set late)
//     stopWalk(): forget the click-to-go goal (city.js owns it)
//   player.mode       what moves the player this frame, in the order city.js's frame loop asks:
//                     'fly' | 'passenger' | 'bike' | 'car' | 'down' | 'flung' | 'door' | 'indoors' | 'swim' | 'foot'
//   player.can(what)  'jump' | 'swim' | 'car' (E: in or out) | 'walk' (to a point) | 'hit' (be knocked over) | 'door'
//   player.seated     in a car or on a bike, driving or riding along;  player.onFoot  neither, nor flying
//   player.atHome     going through a front door, or inside
//   player.pose       the number everyone else sees (POSE)
//   player.halt()     stop walking and drop out of a jump: what every change of mode starts with
//
// Nothing here touches three.js, so the unit tests (tests/player.test.mjs) run it in node.

// the fall clip's moment of hitting the ground, and the pose numbers others see: one copy each, in
// mp/state.js (the wire format), re-exported here for the game's own use
import { POSE } from './mp/state.js';
export { POSE };
export { FALL_DOWN } from './mp/state.js';

export function createPlayerMode(s, { stopWalk = () => {} } = {}) {
  const seated = () => s.driving.driving || !!s.ride;
  const onFoot = () => !seated() && !s.fly;
  const atHome = () => s.homes.busy || s.homes.inside;
  return {
    get mode() {
      if (s.fly) return 'fly';
      if (s.ride) return 'passenger';
      if (s.driving.driving) return s.driving.rider ? 'bike' : 'car';
      if (s.health.out) return 'down';
      if (s.fling.on) return 'flung';
      if (s.homes.busy) return 'door';
      if (s.homes.inside) return 'indoors';   // walking about inside a house (interior.js)
      return s.swim.on ? 'swim' : 'foot';
    },
    get seated() { return seated(); },
    get onFoot() { return onFoot(); },
    get atHome() { return atHome(); },
    can(what) {
      switch (what) {
        // only from your own feet: not in a car, flying, swimming, at a door, knocked over or already jumping
        case 'jump': return !s.jump.phase && onFoot() && !s.swim.on && !s.homes.busy && !s.fling.on;
        case 'swim': return !s.swim.on && onFoot() && !atHome() && !s.fling.on;
        // E: get in or out (not from the water or a doorstep; knocked out, nothing)
        case 'car': return !s.health.out && !atHome() && !s.swim.on;
        case 'walk': return onFoot() && !s.homes.busy;
        case 'hit': return onFoot();
        case 'door': return onFoot() && !s.fling.on;
      }
      throw new Error('player.can: no such thing ' + what);
    },
    get pose() {
      const { homes, health, fling, swim } = s;
      return homes.inside ? POSE.home : homes.busy ? POSE.door : health.out ? POSE.out : fling.on ? (fling.down ? POSE.lying : POSE.flung) : swim.on ? POSE.swim : POSE.normal;
    },
    halt() { stopWalk(); s.jump.phase = null; s.jump.h = 0; },
  };
}
