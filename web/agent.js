// The AI agent's side of the game (tools/mcp): loaded into the page of a ?agent=1 player, it installs
// window.__agentApi, the one narrow interface the MCP server drives the body through. It only reads
// game state (window.__city, the people around from web/mp, window.__agentCall) and moves with the
// game's own human-sized moves (window.__agent.walkTo / stop), so it can do nothing a person can't.
// Multi-step moves (a planned walk, following someone) run here, in the page, so they stop with it.
//
//   snapshot()                          what a person standing there could see (the look tool)
//   walkPlace({ place, person, run, max }), walk(bearing, metres, run), stop()
//   follow(name, gap), stopFollow(reason)
//   waitFor(event, ms) -> bool          arrival, speech, knock, call, person_near
//   toDoor(address, reach), knock(), liveHere(), answerDoor(come), getIn(), rideWith(name), getOut(),
//   driveTo(place), where(person), names(), clearMissed(), busy()
//   sit(), stand()                      in a house: walk to the nearest free chair (or the sofa) and sit down
//
// Loaded by the MCP server after the game is up (page.addScriptTag); it can also be imported in node
// for its pure helpers (tests/agent.test.mjs).

// what others' poses mean (web/mp presence sends them; see city.js body.pose)
const LOCAL_POSE = { normal: 0, flung: 1, lying: 2, home: 3, out: 4, door: 5, swim: 6 };   // (the names web/mp/state.js uses)
export let POSE = LOCAL_POSE;
if (typeof window !== 'undefined') {   // the game's own list when it has one (web/mp/state.js)
  try { const m = await import('./mp/state.js'); if (m.POSE && typeof m.POSE.home === 'number') POSE = { ...LOCAL_POSE, ...m.POSE }; } catch { /* older game: the numbers above */ }
}

export const bearing = (dx, dz) => Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360);   // 0 = north (-z), 90 = east
export const facing = rotY => Math.round(((Math.atan2(-Math.sin(rotY), -Math.cos(rotY)) * 180 / Math.PI) * -1 + 360) % 360);
// what a peer is doing, from what presence tells about them
export function doing(q) {
  if (q.player?.inside) return 'riding in a car';
  if (q.player?.sitting) return 'sitting';
  if (q.car) return q.car.startsWith('bike') ? 'on a motorbike' : 'driving';
  switch (q.pose) {
    case POSE.lying: return 'lying on the ground';
    case POSE.flung: return 'knocked over';
    case POSE.out: return 'knocked out';
    case POSE.swim: return 'swimming';
    case POSE.door: return 'going through a door';
  }
  return q.speed > 2.5 ? 'running' : q.speed > 0.3 ? 'walking' : 'standing';
}
// whether they can be called: the game's own rule when it has one (web/mp/index.js), else from caps
export const canTalk = (q, call) => call?.canTalk ? call.canTalk(q.id) : q.caps === undefined ? !(q.name || '').startsWith('🤖') : q.caps.includes('v');
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// One step of following: keep their trail (so round corners too), drop the points I have reached or
// that are no nearer to them than I am, stop gap metres short. -> { stay } or { to: [x, z], run }
export function trailStep(f, me, g, speed = 0) {
  const last = f.trail[f.trail.length - 1];
  if (!last || Math.hypot(g.x - last[0], g.z - last[1]) > 1) f.trail.push([g.x, g.z]);
  const dMe = Math.hypot(g.x - me.x, g.z - me.z);
  while (f.trail.length && (Math.hypot(f.trail[0][0] - me.x, f.trail[0][1] - me.z) < 1.2 || Math.hypot(f.trail[0][0] - g.x, f.trail[0][1] - g.z) > dMe + 0.5)) f.trail.shift();
  if (f.trail.length > 400) f.trail.splice(0, f.trail.length - 400);
  if (dMe <= f.gap) return { stay: true, dMe };
  const run = dMe > 7 || speed > 2.5;
  let [x, z] = f.trail.length > 1 ? f.trail[0] : [g.x, g.z];
  if (f.trail.length <= 1) { const k = Math.max(0, dMe - f.gap) / dMe; x = me.x + (g.x - me.x) * k; z = me.z + (g.z - me.z) * k; }
  return { to: [x, z], run, dMe };
}

export function install(w = window) {
  const c = () => w.__city, A = () => w.__agent, doc = w.document;
  const peers = () => [...(c().social?.presence.peers.values() || [])];
  const find = (name, within = Infinity, visible = true) => peers().find(q => (!visible || q.player?.group.visible) && q.dist < within && (q.name || '').toLowerCase().includes(String(name).toLowerCase()));
  const bar = () => doc.getElementById('doorbar'), atDoor = () => !!bar() && !bar().hidden;
  const knocks = () => [...doc.querySelectorAll('#mptoasts .toast')].filter(t => /knocking/.test(t.textContent || ''));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms, every = 100) => { for (const t0 = performance.now(); ; await sleep(every)) { if (fn()) return true; if (performance.now() - t0 >= ms) return false; } };
  let walk = null, walkT = null, follow = null, followT = null;

  // the front door of an address ({ label, x, z }, x/z its address point in scene metres): a door near
  // that point whose own address is the same, else the door closest to the point
  const doorOf = a => { const h = c().homes, ds = h.doorsNear(35, { x: a.x, z: a.z }); return ds.find(d => norm(h.addressOf(d)) === norm(a.label)) || ds.find(d => d.dist < 12) || null; };

  // a planned walk goes point by point: the next point is set when the last one is reached
  function stepWalk() {
    const wk = walk; if (!wk) return clearInterval(walkT);
    if (A().walking) return;
    if (wk.direct) {
      const [x, z] = wk.direct, p = c().player.position;
      if (!wk.tried) { wk.tried = true; A().walkTo(x, z, wk.run); return; }
      if (Math.hypot(x - p.x, z - p.z) < 1.5) wk.i = wk.pts.length - 1;   // there
      wk.direct = null;   // or blocked: the planned route then
    }
    if (++wk.i >= wk.pts.length) {
      // an address whose door was not loaded when the walk started: find it now, and walk up to it
      const d = wk.door && !wk.door.done && doorOf(wk.door);
      if (d) { wk.door.done = true; const [x, z] = c().homes.outside(d, 0.9); A().walkTo(x, z, false); return; }
      walk = null; clearInterval(walkT); return;
    }
    const [x, z] = wk.pts[wk.i]; A().walkTo(x, z, wk.run);
  }
  const endWalk = () => { walk = null; clearInterval(walkT); };

  // following: like a person walking after a friend, at human speeds
  function stepFollow() {
    const f = follow; if (!f || f.stopped) return clearInterval(followT);
    const city = c(), q = city.social?.presence.peers.get(f.id), me = city.player.position;
    const why = q?.pose === POSE.home ? 'they went inside' : !q || !q.player?.group.visible ? 'they are out of sight' : q.car || q.player.inside ? 'they got into a car'
      : city.driving.driving || city.homes.inside ? 'you are no longer on foot' : null;
    if (why) return stopFollow(why);
    const g = q.player.group.position, s = trailStep(f, me, g, q.speed || 0);
    if (s.stay) { if (A().walking) A().stop(); f.route = null; return; }
    // no nearer for a few seconds (a fence or canal between you): a planned route along the footpaths
    // to where they are now, until you are close enough to walk their trail again
    const now = Date.now(), dMe = s.dMe;
    if (!(dMe < (f.bestD ?? Infinity) - 1)) { if (!f.sinceProgress) f.sinceProgress = now; } else { f.bestD = dMe; f.sinceProgress = 0; }
    if (f.sinceProgress && now - f.sinceProgress > 4000 && dMe > 6 && !f.route && !f.planning) {
      f.sinceProgress = 0; f.bestD = dMe; f.planning = true;
      city.autopilot.plan({ x: me.x, z: me.z, fx: 0, fz: -1 }, { x: g.x, z: g.z }, 'foot').then(pts => { f.planning = false; if (pts && pts.length > 1) f.route = { pts, i: 1, at: Date.now() }; }).catch(() => { f.planning = false; });
    }
    if (f.route) {
      const r = f.route;
      while (r.i < r.pts.length && Math.hypot(r.pts[r.i][0] - me.x, r.pts[r.i][1] - me.z) < 1.5) r.i++;
      if (r.i >= r.pts.length || dMe < 6 || now - r.at > 60000) f.route = null;   // there, or close: their trail from here
      else { A().walkTo(r.pts[r.i][0], r.pts[r.i][1], s.run); return; }
    }
    A().walkTo(s.to[0], s.to[1], s.run);
  }
  // stopped with a reason: kept (look shows it) until the next move; without: forgotten
  function stopFollow(reason = null) {
    clearInterval(followT);
    if (!follow) return;
    if (reason) follow.stopped = reason; else follow = null;
    A().stop();
  }

  const events = {
    arrival: () => !walk && !A().walking && !c().autopilot.active,
    speech: () => { const v = w.__agentVoice; return !!v && v.heardSince > 0 && performance.now() - v.lastLoud > 800; },
    knock: () => knocks().length > 0,
    call: () => (w.__agentCall?.members.length || 0) > 0 || (w.__agentCalls || []).length > 0,
    person_near: () => peers().some(q => q.player?.group.visible && q.dist < 15),
  };

  const api = {
    version: 1,
    snapshot() {
      const city = c(), p = city.player.position, d = city.driving, h = city.homes, call = w.__agentCall;
      const people = peers().filter(q => q.player?.group.visible && q.dist < 60).map(q => {
        const g = q.player.group.position, dx = g.x - p.x, dz = g.z - p.z;
        return { name: q.name || 'Visitor', metres: Math.round(Math.hypot(dx, dz)), bearing: bearing(dx, dz), doing: doing(q),
          card: q.card === 2 ? 'red card' : q.card === 1 ? 'yellow card' : undefined, can_talk: canTalk(q, call) };
      }).sort((a, b) => a.metres - b.metres);
      const car = !d.driving && d.nearest(p);
      // the nearest front door, measured to the spot in front of it where you can knock
      const dr = h.doorsNear(25)[0], at = atDoor();
      let door = null;
      if (dr) { const [fx, fz] = h.outside(dr, 0.9), dx = fx - p.x, dz = fz - p.z; door = { address: h.addressOf(dr), metres: +Math.hypot(dx, dz).toFixed(1), bearing: bearing(dx, dz) }; }
      const f = follow, hint = doc.getElementById('hint');
      return {
        nearest_address: city.nearestPlace().replace(/\s+·\s+/g, ', '),   // the closest address point: not necessarily the door you are at
        door_address: at && dr ? door.address : null,   // the house whose door you are standing at (you can knock)
        doing: h.inside ? (city.sitting ? 'sitting, inside the house' : 'inside the house') : d.driving ? `${d.model === 'bike' ? 'riding a motorbike' : 'driving'} at ${Math.round(Math.abs(d.speed) * 3.6)} km/h${city.autopilot.active ? `, autopilot to ${city.autopilot.label}, ${(city.autopilot.remaining / 1000).toFixed(1)} km left` : ''}`
          : A().riding ? `riding along with ${A().riding}` : city.fling.on ? 'knocked over' : A().walking ? 'walking' : 'standing',
        facing: facing(city.player.rotation.y),
        home: h.home ? h.home.label : null,
        people,   // each with can_talk: whether they have a voice (you can call them)
        car_nearby: car ? `a parked ${car.model?.name === 'bike' ? 'motorbike' : 'car'} ${Math.round(Math.hypot(car.x - p.x, car.z - p.z))} m away` : null,
        front_door: door,   // { address, metres, bearing } of the nearest front door; knock walks the last few metres itself
        at_door: at,
        following: f ? (f.stopped ? `stopped following ${f.name}: ${f.stopped}` : f.name) : null,
        card: city.card.level === 2 ? 'red' : city.card.level === 1 ? 'yellow' : null,
        missed_calls: (w.__agentCalls || []).slice(),   // people who tried to call you while you had no voice (cleared by look and wait)
        in_call_with: call?.members || [],
        calling: call?.ringing || [],
        knocks: knocks().map(t => t.firstChild?.textContent),
        last_message: hint?.classList.contains('gone') ? null : hint?.textContent,
      };
    },
    clearMissed() { (w.__agentCalls || []).length = 0; },
    names() { return peers().filter(q => q.dist < 60).map(q => (q.name || '').replace(/^🤖\s*/, '')).filter(Boolean).slice(0, 6).join(', '); },
    busy() { return !!walk || c().autopilot.active; },
    waitFor(ev, ms) { const f = events[ev]; return f ? until(f, ms) : sleep(ms).then(() => false); },

    async walkPlace({ place, person, run, max }) {
      const city = c(); stopFollow();
      let hit;
      if (person) {
        const pr = find(person);
        if (!pr) return { error: `Nobody called "${person}" is in sight. (Their meeting link, from where, can bring you near them when you join.)` };
        const g = pr.player.group.position; hit = [g.x + city.ORX, city.ORY - g.z, pr.name];
      } else hit = await city.findPlace(place);
      if (!hit) return { error: `"${place}" not found in this town.` };
      if (city.driving.driving) return { error: 'You are in a car: use drive_to, or get_out first.' };
      let x = hit[0] - city.ORX, z = -(hit[1] - city.ORY);
      // an address: aim for the spot in front of its door (if that square is loaded yet; otherwise
      // the door is found on arrival)
      const door = hit.length === 4 ? { label: hit[2], x, z } : null, d0 = door && doorOf(door);
      if (d0) { [x, z] = city.homes.outside(d0, 0.9); door.done = true; }
      const p = city.player.position, d = Math.hypot(x - p.x, z - p.z);
      if (d > max) return { error: `${hit[2]} is ${Math.round(d)} m away: too far to walk in one go. Take a car (get_in_car, then drive_to).` };
      const pts = (await city.autopilot.plan({ x: p.x, z: p.z, fx: 0, fz: -1 }, { x, z }, 'foot').catch(() => null)) || [[x, z]];
      if (d0) pts.push([x, z]);   // the route ends on the street; then up to the door
      let len = 0, lp = [p.x, p.z]; for (const r of pts) { len += Math.hypot(r[0] - lp[0], r[1] - lp[1]); lp = r; }   // along the footpaths
      // a place nearby: straight there first, stepping round hedges, as a person would (the planned
      // route can go round the block for a house across the street); the route if that fails
      const direct = d < 50 && len > d * 1.5 ? [x, z] : null;
      endWalk(); walk = { pts, i: -1, run, door, direct }; walkT = setInterval(stepWalk, 250); stepWalk();
      if (direct) len = d * 1.2;
      return { to: hit[2], metres: Math.round(len), seconds: Math.round(len / (run ? 6 : 1.8) * 1.2), door: !!door };
    },
    walk(b, m, run) { stopFollow(); endWalk(); const p = c().player.position, a = b * Math.PI / 180; return A().walkTo(p.x + Math.sin(a) * m, p.z - Math.cos(a) * m, run); },
    stop() { stopFollow(); endWalk(); A().stop(); const ap = c().autopilot; if (ap.active) ap.stop(); },
    stopFollow,
    follow(name, gap) {
      stopFollow();
      const city = c(), q = find(name, 60); if (!q) return null;
      if (city.driving.driving || city.homes.inside) return { error: 'You need to be on foot, outside.' };
      endWalk();
      follow = { id: q.id, name: q.name, gap, trail: [], stopped: null }; followT = setInterval(stepFollow, 300);
      return { name: q.name, metres: Math.round(q.dist) };
    },

    // up to the door: the spot in front of the nearest front door within reach (or of a given address
    // near you), walked at a person's pace; { at: true } once the game shows you are at it
    async toDoor(a, reach) {
      stopFollow();
      const city = c(), h = city.homes;
      if (city.driving.driving || h.inside) return { error: 'You need to be on foot, outside.' };
      let d;
      if (a) {
        d = h.doorsNear(reach).find(d => norm(h.addressOf(d)) === norm(a));
        if (!d) return { error: `No front door of ${a} within ${reach} m of you. walk_to "${a}" takes you to it.` };
        if (atDoor() && norm(h.addressOf(h.doorsNear(h.NEAR)[0])) === norm(a)) return { at: true };
      } else {
        if (atDoor()) return { at: true };
        d = h.doorsNear(reach)[0];
        if (!d) return { error: `No front door within ${reach} m: walk up to one first (look shows the nearest, with its bearing).` };
      }
      const [x, z] = h.outside(d, 0.9), addr = h.addressOf(d); endWalk(); A().walkTo(x, z, false);
      await until(() => !A().walking, 10000, 250);   // a person covers ~15 m in that time
      await until(atDoor, 1000, 100);   // the door buttons follow a moment later
      return atDoor() ? { at: true, walked: addr } : { error: `Could not reach the door of ${addr}.` };
    },
    knock() { const h = c().homes, d = h.doorsNear(h.NEAR)[0]; h.knock(); return d ? h.addressOf(d) : 'the door'; },
    liveHere() { if (!atDoor()) return false; c().homes.liveHere(); return true; },
    // come: let them in when you are inside (or come to the door); else not now. -> the button pressed
    answerDoor(come) { const t = knocks()[0]; if (!t) return false; const bs = [...t.querySelectorAll('button')], b = come ? bs[0] : bs[bs.length - 1]; b.click(); return b.textContent; },
    async homeMove(inside) { const h = c().homes; inside ? h.goIn() : h.comeOut(); await sleep(300); await until(() => !h.busy, 4000); },

    getIn() {
      stopFollow();
      const city = c(); if (city.driving.driving) return 'You are already driving.';
      const car = city.driving.nearest(city.player.position); city.toggleCar();
      return city.driving.driving ? `You are in the ${city.driving.model === 'bike' ? 'motorbike' : 'car'}.` : A().riding ? 'You are riding along with the driver next to you.' : car ? 'Could not get in.' : 'No car within reach: walk closer to one first (look shows the nearest).';
    },
    // ride along: walk up to their car (at most 10 s), keeping after it if it moves, and get in
    async rideWith(n) {
      stopFollow();
      const city = c(), q = find(n, Infinity, false);
      if (!q || q.player?.group.visible === false) return `Nobody called "${n}" is near you.`;
      if (!q.car || q.car.startsWith('ride')) return `${q.name} is not driving: they need to be in a car (then you can ride along).`;
      if (city.driving.driving) return 'You are driving yourself: get_out first.';
      if (q.dist > 30) return `${q.name}'s car is ${Math.round(q.dist)} m away: walk closer first (walk_to with person).`;
      endWalk();
      const near = () => { const r = city.social?.presence.peers.get(q.id); if (!r?.player) return true; const g = r.player.group.position, p = city.player.position; if (Math.hypot(g.x - p.x, g.z - p.z) < 3.2) { A().stop(); return true; } A().walkTo(g.x, g.z, Math.hypot(g.x - p.x, g.z - p.z) > 8); return false; };
      await until(near, 10000, 250);
      city.toggleCar();
      return A().riding ? `You got in with ${q.name}: they drive. look and wait to see where you go; get_out to get out.` : `Could not reach ${q.name}'s car (it may have driven off).`;
    },
    getOut() { const city = c(), r = A().riding; if (!city.driving.driving && !r) return 'You are not in a car.'; city.toggleCar(); return r ? `You got out of ${r}'s car.` : 'You got out.'; },
    async driveTo(place) {
      const city = c(); if (!city.driving.driving) return 'You are not in a car: get_in_car first.';
      const hit = await city.findPlace(place); if (!hit) return `"${place}" not found in this town.`;
      await city.autoTo(hit[0] - city.ORX, -(hit[1] - city.ORY), hit[2]);
      return city.autopilot.active ? `Driving to ${hit[2]}, ${(city.autopilot.remaining / 1000).toFixed(1)} km. Use wait to follow along.` : 'No road there from here.';
    },
    where(who) {
      const city = c(); let x, z, name = 'you';
      if (who) { const pr = find(who); if (!pr) return null; ({ x, z } = pr.player.group.position); name = pr.name; } else ({ x, z } = city.player.position);
      const [X, Y] = city.toRD(x, z), [lat, lon] = city.rdToWgs(X, Y), q = new URLSearchParams(w.location.search), u = new URL(w.location.pathname, w.location.origin);
      for (const k of ['place', 'region']) if (q.get(k)) u.searchParams.set(k, q.get(k));
      u.searchParams.set('meet', X.toFixed(1) + ',' + Y.toFixed(1));
      return { who: name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), rd: [+X.toFixed(1), +Y.toFixed(1)], meeting_link: u.href };
    },
    // a seat in the house: walk (at a person's pace) to beside the nearest free one, then sit down
    async sit(kind) {
      stopFollow(); endWalk();
      const city = c(), room = city.room, p = city.player.position;
      if (!city.homes.inside || !room.active) return 'You can only sit down inside a house.';
      if (city.sitting) return 'You are already sitting.';
      const taken = peers().filter(q => q.player?.sitting).map(q => [q.player.group.position.x, q.player.group.position.z]);
      const free = room.seats.filter(s => !taken.some(([x, z]) => Math.hypot(x - s.x, z - s.z) < 0.35) && (!kind || s.kind === kind))
        .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      const s = free[0]; if (!s) return 'Every seat is taken.';
      const [x, z] = room.standSpot(s, (x, z) => !city.blocked(x, z));
      A().walkTo(x, z, false);
      await until(() => !A().walking, 10000, 250);
      return city.sitDown(s) ? `You sat down on the ${s.kind === 'chair' ? 'chair at the table' : s.kind}.` : 'Could not reach that seat.';
    },
    stand() { const city = c(); if (!city.sitting) return 'You are not sitting.'; city.standUp(); return 'You stood up.'; },
    leave() { stopFollow(); endWalk(); },
  };
  w.__agentApi = api;
  return api;
}

if (typeof window !== 'undefined' && window.__city && window.__agent && !window.__agentApi) install();
