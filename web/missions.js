// Klusjes: short, friendly street missions. Bring a parcel, fetch flowers from the bloemist, or do a
// little round past three places. The reward is stars (localStorage 'toycity.stars'); being late only
// costs a "volgende keer beter!".
//
//   const missions = createMissions({ player, driving, scene, note, index, toRD, fromRD, inside, heading, onReward });
//   missions.update(dt);                // each frame: one distance check, the beacon pulse, a timer
//   missions.offer(); accept(); cancel(); missions.active -> mission | null; missions.stats -> { stars, done, late }
//   mountMissions(document.getElementById('mission'), missions);
//
// The pure parts (timer, reached, hint arrow, picking) are exported for tests and take plain numbers.

// ---------- pure helpers ----------
export const REACH_FOOT = 6, REACH_CAR = 10, STOPPED = 0.3;
export const timeLimit = distM => 90 + distM / 10;                       // seconds: generous
export const dist2d = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);
// at the waypoint: on foot within 6 m, or in a car that has stopped within 10 m
export function reached(px, pz, tx, tz, { inCar = false, speed = 0 } = {}) {
  const d = dist2d(px, pz, tx, tz);
  return inCar ? d <= REACH_CAR && Math.abs(speed) < STOPPED : d <= REACH_FOOT;
}
export const fmtDist = m => m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km';
export const fmtTime = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
// an arrow as seen on screen: yaw is the camera azimuth of city.js (camera sits at player + (sin yaw, cos yaw)),
// so screen-up is (-sin yaw, -cos yaw). yaw 0 = north is up.
export function hint(px, pz, tx, tz, yaw = 0) {
  const dx = tx - px, dz = tz - pz, d = Math.hypot(dx, dz);
  const fwd = -dx * Math.sin(yaw) - dz * Math.cos(yaw), right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const a = Math.atan2(right, fwd), k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return (d < 12 ? '📍' : ARROWS[k]) + ' ' + fmtDist(d);
}
// a small deterministic PRNG (mulberry32): the same seed gives the same klusje
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, l) => l[Math.floor(r() * l.length)];

// shops by name: the search index has no categories, but Dutch shop names say what they are
export const SHOPS = [
  { cat: 'bloemist', re: /bloem|flori|tulp/i, item: 'een bos tulpen', emoji: '🌷', en: 'flowers' },
  { cat: 'bakker', re: /bakker|brood|patisserie/i, item: 'een vers brood', emoji: '🥖', en: 'bread' },
  { cat: 'ijssalon', re: /ijssalon|ijs[- ]?salon|gelat/i, item: 'twee bolletjes ijs', emoji: '🍦', en: 'ice cream' },
  { cat: 'bibliotheek', re: /bibliotheek|bieb\b/i, item: 'een spannend boek', emoji: '📚', en: 'a book' },
  { cat: 'supermarkt', re: /albert heijn|jumbo(?! )|supermarkt|lidl|aldi|dirk|\bplus\b|markt\b/i, item: 'een tasje boodschappen', emoji: '🛒', en: 'groceries' },
  { cat: 'apotheek', re: /apotheek/i, item: 'een pleisterdoos', emoji: '🩹', en: 'plasters' },
  { cat: 'kapper', re: /kapper|hair|barber/i, item: 'een cadeaubon', emoji: '🎁', en: 'a gift card' },
  { cat: 'snackbar', re: /snack|friet|frituur|pizza/i, item: 'een zakje friet', emoji: '🍟', en: 'chips' },
];
const PARCELS = [['een pakketje', '📦', 'a parcel'], ['een doos met puzzels', '🧩', 'a box of puzzles'], ['een brief', '✉️', 'a letter'], ['een taart', '🎂', 'a cake'], ['een plant', '🪴', 'a plant'], ['een doos ballonnen', '🎈', 'balloons']];
const NAMES = ['De Vries', 'Jansen', 'De Jong', 'Bakker', 'Visser', 'Smit', 'Meijer', 'Mulder', 'Bos', 'Vos', 'De Groot', 'Van Dijk', 'Peters', 'Hendriks', 'Dekker', 'Brouwer', 'Kok', 'Van den Berg', 'Willems', 'Van Leeuwen'];
const WHO = ['Mevrouw', 'Meneer', 'Opa', 'Oma', 'Juf', 'Meester', 'Buurvrouw', 'Buurman'];
const VISITS = /park|speeltuin|speelplaats|bibliotheek|school|kinderboerderij|zwembad|sporthal|ijsbaan|museum|station|kerk|molen|bakker|bloem|ijssalon/i;

// pick a klusje from a search index ({ addr: [[street, nr, X, Y]], pois: [[name, X, Y]] }) around an RD
// point. `inside(X, Y)` says whether a point lies in the loaded town. Deterministic for a given seed.
export function pickMission(index, X, Y, seed, { inside = () => true, kind } = {}) {
  const r = rng(seed);
  const near = (list, lo, hi, cx = X, cy = Y) => list.filter(p => { const d = Math.hypot(p.X - cx, p.Y - cy); return d >= lo && d <= hi && inside(p.X, p.Y); });
  const addrs = index.addr.map(([s, n, x, y]) => ({ label: s + ' ' + n, X: x, Y: y }));
  const pois = index.pois.map(([n, x, y]) => ({ label: n, X: x, Y: y }));
  const who = pick(r, WHO) + ' ' + pick(r, NAMES);
  // straight-line 250-950 m is about 300-1200 m by road
  const house = (cx, cy) => pick(r, near(addrs, 250, 950, cx, cy).length ? near(addrs, 250, 950, cx, cy) : near(addrs, 60, 2500, cx, cy));
  const kinds = ['bezorging', 'ophalen', 'rondje'];
  kind ||= kinds[Math.floor(r() * 3)];
  if (kind === 'ophalen') {
    const shops = SHOPS.map(s => ({ s, at: near(pois.filter(p => s.re.test(p.label)), 0, 1500) })).filter(x => x.at.length);
    if (!shops.length) kind = 'bezorging';
    else {
      const { s, at } = pick(r, shops), shop = at.sort((a, b) => Math.hypot(a.X - X, a.Y - Y) - Math.hypot(b.X - X, b.Y - Y))[Math.floor(r() * Math.min(3, at.length))];
      const home = house(shop.X, shop.Y); if (!home) return null;
      const total = Math.hypot(shop.X - X, shop.Y - Y) + Math.hypot(home.X - shop.X, home.Y - shop.Y);
      return { kind, who, emoji: s.emoji, item: s.item, reward: 2, limit: timeLimit(total * 1.3),
        title: `${s.emoji} ${s.item} voor ${who}`,
        line: `${who} op ${home.label} wil graag ${s.item} ${s.emoji}. Haal het bij ${shop.label}! (fetch ${s.en} at ${shop.label}, bring it to ${home.label})`,
        stops: [{ X: shop.X, Y: shop.Y, label: shop.label, step: 'pickup', say: `${s.emoji} Opgehaald bij ${shop.label}! Nu naar ${who} op ${home.label}.` },
                { X: home.X, Y: home.Y, label: home.label, step: 'drop', say: `${s.emoji} Dankjewel! ${who} is heel blij.` }] };
    }
  }
  if (kind === 'rondje') {
    const spots = near(pois.filter(p => VISITS.test(p.label)), 150, 900), chosen = [];
    const seen = new Set();
    while (chosen.length < 3 && spots.length) { const p = spots.splice(Math.floor(r() * spots.length), 1)[0]; const k = p.label; if (seen.has(k) || chosen.some(c => Math.hypot(c.X - p.X, c.Y - p.Y) < 80)) continue; seen.add(k); chosen.push(p); }
    if (chosen.length < 3) kind = 'bezorging';
    else {
      // rough length: nearest-neighbour from the start
      let cx = X, cy = Y, total = 0, left = [...chosen];
      while (left.length) { left.sort((a, b) => Math.hypot(a.X - cx, a.Y - cy) - Math.hypot(b.X - cx, b.Y - cy)); const p = left.shift(); total += Math.hypot(p.X - cx, p.Y - cy); cx = p.X; cy = p.Y; }
      return { kind, who, emoji: '🚲', item: 'een rondje', reward: 3, limit: timeLimit(total * 1.3), any: true,
        title: '🗺️ Rondje langs drie plekken',
        line: `Een rondje! Ga langs ${chosen.map(c => c.label).join(', ')} – in elke volgorde. (visit all three, any order)`,
        stops: chosen.map(p => ({ X: p.X, Y: p.Y, label: p.label, step: 'visit', say: `✅ ${p.label} gezien!` })) };
    }
  }
  // bezorging: a parcel from the shop next to you (within 120 m), else it is already in your hands
  const [item, emoji, en] = pick(r, PARCELS);
  const home = house(X, Y); if (!home) return null;
  const shopNear = near(pois.filter(p => SHOPS.some(s => s.re.test(p.label)) || /post|pakket|winkel|shop|bruna|primera/i.test(p.label)), 15, 120)[0];
  const total = (shopNear ? Math.hypot(shopNear.X - X, shopNear.Y - Y) : 0) + Math.hypot(home.X - (shopNear || { X }).X, home.Y - (shopNear || { Y }).Y);
  const stops = [];
  if (shopNear) stops.push({ X: shopNear.X, Y: shopNear.Y, label: shopNear.label, step: 'pickup', say: `${emoji} Pakketje opgehaald! Nu naar ${who} op ${home.label}.` });
  stops.push({ X: home.X, Y: home.Y, label: home.label, step: 'drop', say: `${emoji} Bezorgd! ${who} zwaait je uit.` });
  return { kind: 'bezorging', who, emoji, item, reward: total > 700 ? 2 : 1, limit: timeLimit(total * 1.3),
    title: `${emoji} Bezorging voor ${who}`,
    line: `${who} op ${home.label} wacht op ${item} ${emoji}.${shopNear ? ` Haal het op bij ${shopNear.label}.` : ''} (deliver ${en} to ${home.label})`,
    stops };
}

// ---------- the live part ----------
const STARS = 'toycity.stars';
export function createMissions({ player, driving, scene, note = () => {}, index, places, toRD, fromRD, inside, heading, onReward = () => {}, seed, THREE: THREE0 } = {}) {
  const src = index || places;
  let idx = null, loading = null;
  const loadIndex = () => loading ||= Promise.resolve(typeof src === 'function' ? src() : src).then(i => (idx = i));
  const stats = { stars: 0, done: 0, late: 0 };
  try { Object.assign(stats, JSON.parse(localStorage.getItem(STARS) || '{}')); } catch { /* fresh */ }
  if (typeof stats.stars !== 'number') stats.stars = +stats.stars || 0;
  const save = () => { try { localStorage.setItem(STARS, JSON.stringify(stats)); } catch { /* private mode */ } };

  let offered = null, active = null, hudT = 0, pulse = 0, n = 0, last = '';
  const listeners = new Set();
  const changed = () => { for (const f of listeners) try { f(api); } catch (e) { console.warn('missions listener', e); } };

  // the beacon: a flat ring and a thin pillar of light, pulsing. three.js is loaded lazily so this
  // module also imports in node (tests) without it.
  let THREE = THREE0 || null, beacon = null;
  if (scene) (THREE ? Promise.resolve(THREE) : import('three')).then(m => { THREE = m; makeBeacon(); }).catch(e => console.warn('missions: no beacon', e));
  function makeBeacon() {
    if (beacon || !THREE) return;
    beacon = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff7a3d, transparent: true, opacity: 0.85, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.8, 40).rotateX(-Math.PI / 2), mat);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.6, 14, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
    pillar.position.y = 7;
    beacon.add(ring, pillar); beacon.renderOrder = 9; beacon.visible = false; scene.add(beacon);
    place();
  }
  const toWorld = s => { if (s.x === undefined) { const [x, z] = fromRD ? fromRD(s.X, s.Y) : [s.X, s.Y]; s.x = x; s.z = z; } return s; };
  function target() { if (!active) return null; if (!active.any) return toWorld(active.stops[active.i]); let best = null, bd = Infinity; for (const s of active.stops) { if (s.done) continue; toWorld(s); const d = dist2d(player.position.x, player.position.z, s.x, s.z); if (d < bd) { bd = d; best = s; } } return best; }
  function place() { if (!beacon) return; const t = target(); beacon.visible = !!t; if (t) beacon.position.set(t.x, 0.2, t.z); }

  function here() { const [X, Y] = toRD ? toRD(player.position.x, player.position.z) : [player.position.x, player.position.z]; return [X, Y]; }
  async function offer({ kind } = {}) {
    if (active) return active;
    await loadIndex().catch(e => { console.warn('missions: no search index', e); });
    if (!idx) { note('📦 Nog geen klusjes hier.'); return null; }
    const [X, Y] = here();
    const s = (seed ?? Math.floor(Date.now() / 864e5) * 131) + stats.done * 7 + n++;
    offered = pickMission(idx, X, Y, s, { inside, kind });
    if (!offered) { note('📦 Geen klusje in de buurt, loop eens verder.'); changed(); return null; }
    note(offered.line.replace(/\s*\(.*\)\s*$/, ''));   // the short line; the full one is in the offer card
    changed();
    return offered;
  }
  function accept() {
    if (active || !offered) return active;
    active = offered; offered = null; active.i = 0; active.left = active.limit; active.t = 0;
    for (const s of active.stops) { s.done = false; toWorld(s); }
    const t = target();
    note(`${active.emoji} Op weg naar ${t.label}. Je hebt ${fmtTime(active.limit)} minuten.`);
    place(); changed();
    return active;
  }
  function cancel(why) {
    if (!active && !offered) return;
    active = null; offered = null; place();
    if (why) note(why);
    changed();
  }
  function finish() {
    stats.stars += active.reward; stats.done++; save();
    const r = active.reward; active = null; place();
    note(`🌟 Gelukt! +${r} ${r === 1 ? 'ster' : 'sterren'} (nu ${stats.stars}). Klaar voor het volgende klusje?`);
    try { onReward(r, { ...stats }); } catch (e) { console.warn('onReward', e); }
    changed();
  }

  const api = {
    update(dt) {
      if (!active) return;
      active.t += dt; active.left -= dt; pulse += dt;
      if (beacon) { const k = 1 + 0.18 * Math.sin(pulse * 4); beacon.scale.set(k, 1 + 0.05 * Math.sin(pulse * 3), k); beacon.children[0].material.opacity = 0.6 + 0.3 * Math.sin(pulse * 4); }
      const t = target();
      if (!t) return finish();
      const p = player.position, inCar = !!driving?.driving, speed = driving?.speed || 0;
      if (reached(p.x, p.z, t.x, t.z, { inCar, speed })) {
        t.done = true; active.i++;
        if (active.stops.every(s => s.done)) return finish();
        note(t.say); place(); changed(); return;
      }
      if (active.left <= 0) { stats.late++; save(); return cancel('⏰ Te laat, volgende keer beter! Vraag gerust een nieuw klusje.'); }
      if ((hudT += dt) > 0.25) { hudT = 0; const h = hint(p.x, p.z, t.x, t.z, heading ? heading() : 0); const s = `${active.emoji} ${t.label} · ${h} · ⏱ ${fmtTime(active.left)}`; if (s !== last) { last = s; changed(); } }
    },
    offer, accept, cancel,
    get active() { return active; },
    get offered() { return offered; },
    get stats() { return { ...stats }; },
    get line() { if (!active) return ''; const t = target(); return t ? `${active.emoji} ${t.label} · ${hint(player.position.x, player.position.z, t.x, t.z, heading ? heading() : 0)} · ⏱ ${fmtTime(active.left)}` : ''; },
    get idle() { return !active && !offered && (!driving?.driving || Math.abs(driving.speed || 0) < STOPPED); },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    dispose() { listeners.clear(); if (beacon) { scene.remove(beacon); beacon = null; } active = offered = null; },
  };
  return api;
}

// HUD: a "📦 Klusje" button when you are on foot or stopped; the offer with "Doen!" / "Liever niet";
// the running mission as a line with a small stop button. Markup: <div id="mission"></div>.
export function mountMissions(container, missions) {
  container.innerHTML = '<button type="button" class="ask">📦 Klusje</button><span class="offer" hidden><span class="text"></span><button type="button" class="yes">👍 Doen!</button><button type="button" class="no">Liever niet</button></span><span class="run" hidden><span class="text"></span><button type="button" class="stop" title="Stop dit klusje" aria-label="Stop">✖</button></span>';
  const ask = container.querySelector('.ask'), offer = container.querySelector('.offer'), run = container.querySelector('.run');
  const ot = offer.querySelector('.text'), rt = run.querySelector('.text');
  ask.addEventListener('click', e => { e.stopPropagation(); missions.offer(); });
  offer.querySelector('.yes').addEventListener('click', e => { e.stopPropagation(); missions.accept(); });
  offer.querySelector('.no').addEventListener('click', e => { e.stopPropagation(); missions.cancel(); });
  run.querySelector('.stop').addEventListener('click', e => { e.stopPropagation(); missions.cancel('📦 Klusje gestopt. Geen probleem!'); });
  const draw = () => {
    const a = missions.active, o = missions.offered;
    ask.hidden = !!a || !!o || !missions.idle;
    offer.hidden = !o; if (o) ot.textContent = o.title + ' · ' + fmtTime(o.limit) + ' · ' + '⭐'.repeat(o.reward);
    run.hidden = !a; if (a) rt.textContent = missions.line;
    container.classList.toggle('empty', ask.hidden && !a && !o);
  };
  const off = missions.onChange(draw);
  // idle (on foot or stopped) changes without a mission event: look twice a second
  const iv = setInterval(() => { if (!missions.active && !missions.offered && ask.hidden === missions.idle) draw(); }, 500);
  draw();
  container.unmount = () => { off(); clearInterval(iv); container.innerHTML = ''; };
  return container;
}
