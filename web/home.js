// Front doors and homes: walk up to a house, knock, or make it your home and go inside.
//
//   Doors      Every front door is a flat instance in its square (tilebake.py). The ones near you are
//              swapped for a real door (models/door.glb, built by tools/door_model.py) that can swing open.
//   Knocking   K or the 🚪 button at a door. The knock goes to everyone who lives there, wherever they are,
//              through a small multiplayer room named after the door (presence.channel). They get a toast,
//              and a system notification when the game is in the background; they can come to the door.
//   Home       "Live here" saves the door as your home (this browser only). At your own door you can go
//              inside: the door opens, you step in and it shuts behind you; others no longer see you.
//              While you are home (or anywhere else) you hear knocks; "Step outside" walks you out again.
//
//   const homes = createHomes({ scene, player, tiles, T, toRD, fromRD, slug, note, loader, look })
//   homes.update(dt, onFoot) every frame; returns true while it moves the player (stepping in or out)
//   look(yaw)               turn the camera to face this door from the street
//   homes.connect(presence) once multiplayer is up
//   homes.inside            true while you are at home
import * as THREE from 'three';

const NEAR = 2.2;            // metres from a door to knock or go in
const POOL = 14;             // real doors around you
const KEY = 'toycity.home';
const OPEN = 1.35;           // radians the door swings in

export function createHomes({ scene, player, tiles, T, toRD, fromRD, slug, note, loader, look = () => {} }) {
  let model = null;
  loader.loadAsync(new URL('./models/door.glb', import.meta.url).href).then(g => {
    // each part is a mesh, or a group of meshes when it has several materials
    model = { frame: g.scene.getObjectByName('door_frame'), leaf: g.scene.getObjectByName('door_leaf') };
    if (!model.frame || !model.leaf) model = null;
  }).catch(e => console.warn('door model', e));

  let home = null; try { home = JSON.parse(localStorage.getItem(KEY)); } catch { /* none */ }
  let presence = null, myRoom = null, inside = false, walk = null, near = null;
  const pool = new Map();    // door id -> { group, leaf, angle, want, tile, n }
  const toasts = () => document.getElementById('mptoasts') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'mptoasts' }));

  // ---------- the doors around you ----------
  // a door: [x, y (its middle), z, yaw, scale, colour] in its square; outside is +z turned by yaw
  function doorsNear(r) {
    const out = [], p = player.position;
    for (const t of tiles.values()) {
      if (!t.doors) continue;
      const d = t.doors, ox = t.group.position.x, oz = t.group.position.z;
      for (let k = 0; k < d.length; k += 6) {
        const x = d[k] + ox, z = d[k + 2] + oz, dist = Math.hypot(x - p.x, z - p.z);
        if (dist < r) out.push({ tile: t, n: k / 6, x, y: d[k + 1] - 1.1, z, yaw: d[k + 3], color: d[k + 5], dist });
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }
  const idOf = d => { const [X, Y] = toRD(d.x, d.z); return Math.round(X) + ',' + Math.round(Y); };
  // the address of a door: the nearest address point of its square, within 15 m
  function addressOf(d) {
    const [X, Y] = toRD(d.x, d.z); let best = 225, label = null;
    for (const t of tiles.values()) {
      if (!t.meta) continue;
      for (const [s, n, x, y] of t.meta.addr) { const dd = (x + t.i * T - X) ** 2 + (y + t.j * T - Y) ** 2; if (dd < best) { best = dd; label = s + ' ' + n; } }
    }
    return label || 'this house';
  }
  const HALL = new THREE.PlaneGeometry(0.96, 2.12), HALL_MAT = new THREE.MeshBasicMaterial({ color: 0x1d1712 });
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0), M4 = new THREE.Matrix4();
  function hideFlat(d, on) {   // the flat door instance under a real one
    const m = d.tile.doorMesh; if (!m) return;
    if (on) { m.getMatrixAt(d.n, M4); (d.tile.doorKeep ||= new Map()).set(d.n, M4.clone()); m.setMatrixAt(d.n, ZERO); }
    else if (d.tile.doorKeep?.has(d.n)) { m.setMatrixAt(d.n, d.tile.doorKeep.get(d.n)); d.tile.doorKeep.delete(d.n); }
    m.instanceMatrix.needsUpdate = true;
  }
  function realDoor(d) {
    const g = new THREE.Group(); g.position.set(d.x, d.y, d.z); g.rotation.y = d.yaw;
    const frame = model.frame.clone(); g.add(frame);
    const hall = new THREE.Mesh(HALL, HALL_MAT); hall.position.set(0, 1.06, -0.35); g.add(hall);   // dark hallway behind the open door
    const hinge = model.leaf.clone(); g.add(hinge);   // its origin is the hinge
    hinge.traverse(o => { if (o.isMesh && o.material.name.startsWith('paint')) { o.material = o.material.clone(); o.material.color.setHex(d.color); o.material.userData.own = true; } });
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    scene.add(g);
    return { group: g, leaf: hinge, angle: 0, want: 0, tile: d.tile, n: d.n, d };
  }
  function dropDoor(id) {
    const r = pool.get(id); if (!r) return;
    r.group.removeFromParent(); r.group.traverse(o => { if (o.isMesh) [].concat(o.material).forEach(m => m.userData.own && m.dispose()); });
    hideFlat(r.d, false); pool.delete(id);
  }
  function refreshPool() {
    if (!model) return;
    const want = new Map(doorsNear(30).slice(0, POOL).map(d => [idOf(d), d]));
    for (const id of [...pool.keys()]) if (!want.has(id) && pool.get(id).angle < 0.01) dropDoor(id);
    for (const [id, d] of want) if (!pool.has(id) && d.tile.doorMesh) { pool.set(id, realDoor(d)); hideFlat(d, true); }
  }
  const swing = (id, open) => { const r = pool.get(id); if (r) r.want = open ? OPEN : 0; };

  // ---------- sounds ----------
  let ctx = null;
  const audio = () => { try { ctx ||= new AudioContext(); if (ctx.state === 'suspended') ctx.resume(); return ctx; } catch { return null; } };
  function knockSound(n = 3) {
    const a = audio(); if (!a) return;
    for (let i = 0; i < n; i++) {
      const t = a.currentTime + i * 0.22, src = a.createBufferSource(), buf = a.createBuffer(1, a.sampleRate * 0.12, a.sampleRate), ch = buf.getChannelData(0);
      for (let j = 0; j < ch.length; j++) ch[j] = (Math.random() * 2 - 1) * Math.exp(-j / (a.sampleRate * 0.012));
      const f = a.createBiquadFilter(), g = a.createGain(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 1.2; g.gain.value = 0.9;
      src.buffer = buf; src.connect(f).connect(g).connect(a.destination); src.start(t);
    }
  }
  function toast(text, buttons = [], ms = 15000) {
    const el = document.createElement('div'); el.className = 'toast'; el.append(text);
    for (const [label, fn] of buttons) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { el.remove(); fn(); }; el.append(b); }
    toasts().append(el); if (ms) setTimeout(() => el.remove(), ms);
  }

  // ---------- knocking ----------
  async function knock(d) {
    if (!d) return;
    knockSound(); swing(idOf(d), false);
    const label = addressOf(d);
    if (!presence) { note(`🚪 You knock at ${label}. Nobody answers.`); return; }
    note(`🚪 You knock at ${label}…`);
    const ch = presence.channel('home:' + idOf(d));
    let answered = false;
    ch.onMessage(m => {
      if (!m || typeof m !== 'object') return;
      const who = String(m.name || 'Someone').slice(0, 40);
      if (m.t === 'coming') { answered = true; note(`🏠 ${who} heard you and is coming to the door.`); }
      if (m.t === 'away') { answered = true; note(`🏠 ${who} can't come to the door right now.`); }
    });
    // wait for the residents' browsers to connect, then knock (again for any who join a little later)
    for (let i = 0; i < 12 && !ch.peers().length; i++) await new Promise(r => setTimeout(r, 500));
    const msg = { t: 'knock', name: presence.name, at: label };
    ch.send(msg); setTimeout(() => ch.send(msg), 2500);
    setTimeout(() => { if (!answered) note(`🚪 Nobody answers at ${label}.`); }, 15000);
    setTimeout(() => ch.leave(), 30000);
  }

  // ---------- your home ----------
  function listen() {
    myRoom?.leave(); myRoom = null;
    if (!home || !presence) return;
    myRoom = presence.channel('home:' + home.id);
    myRoom.onMessage((m, from) => {
      if (m?.t !== 'knock') return;
      const who = String(m.name || 'Someone').slice(0, 40);
      knockSound(); note(`🚪 ${who} is knocking at your door.`);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Toy City', { body: `${who} is knocking at your door (${home.label}).` });
      toast(`🚪 ${who} is knocking at ${home.label}`, [
        ['Come to the door', () => { myRoom.send({ t: 'coming', name: presence.name }, from); comeOut(); }],
        ['Not now', () => myRoom.send({ t: 'away', name: presence.name }, from)],
      ]);
    });
  }
  function liveHere(d) {
    home = { id: idOf(d), label: addressOf(d), slug, rd: toRD(d.x, d.z), yaw: d.yaw };
    localStorage.setItem(KEY, JSON.stringify(home));
    note(`🏠 ${home.label} is your home now. You'll hear it when someone knocks.`);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    listen(); ui();
  }
  // your door, wherever you are: the real door near you (when you are home), else where it was saved
  function homeDoor() {
    if (!home) return null;
    if (home.slug !== slug) return null;
    const [x, z] = fromRD(home.rd[0], home.rd[1]);
    return { x, z, yaw: home.yaw };
  }
  const out = (d, k) => [d.x + Math.sin(d.yaw) * k, d.z + Math.cos(d.yaw) * k];   // k metres out of the door

  // go in: the door opens, you walk in, it shuts. Out: the reverse, ending on the doorstep facing the street.
  function goIn() {
    const d = homeDoor(); if (!d || inside || walk) return;
    walk = { d, from: out(d, 1.2), to: out(d, -1.0), t: 0, dir: 'in' }; look(d.yaw);
    swing(home.id, true);
  }
  function comeOut() {
    if (walk) return;
    const d = homeDoor();
    if (!d) { if (home) location.href = `city.html?region=${encodeURIComponent(home.slug)}&meet=${home.rd[0].toFixed(1)},${home.rd[1].toFixed(1)}&home=out`; return; }
    if (!inside) { player.position.x = out(d, -1.0)[0]; player.position.z = out(d, -1.0)[1]; inside = true; }
    walk = { d, from: out(d, -1.0), to: out(d, 1.6), t: 0, dir: 'out' }; look(d.yaw);
    swing(home.id, true);
  }

  // ---------- the buttons at a door ----------
  const bar = document.createElement('div'); bar.id = 'doorbar'; bar.hidden = true; document.body.append(bar);
  const panel = document.createElement('div'); panel.id = 'homepanel'; panel.hidden = true; document.body.append(panel);
  function button(text, fn) { const b = document.createElement('button'); b.textContent = text; b.onclick = e => { e.stopPropagation(); fn(); }; return b; }
  let shown = '';
  function ui() {
    const mine = near && home && idOf(near) === home.id;
    const key = inside ? 'inside' : near ? (mine ? 'mine:' : 'door:') + idOf(near) : '';
    if (key === shown) return; shown = key;
    bar.replaceChildren(); panel.replaceChildren();
    bar.hidden = !near || inside; panel.hidden = !inside;
    if (inside) {
      panel.append(Object.assign(document.createElement('div'), { textContent: `🏠 Home, ${home.label}` }),
        Object.assign(document.createElement('small'), { textContent: '🔔 You will hear it when someone knocks.' }),
        button('🚪 Step outside', comeOut));
      return;
    }
    if (!near) return;
    if (mine) bar.append(button('🏠 Go inside (L)', goIn));
    else bar.append(button('🚪 Knock (K)', () => knock(near)), button('🏠 Live here (L)', () => liveHere(near)));
    // the same in the hint line at the top, in case the buttons are covered
    note(mine ? `🏠 Your home, ${home.label}: L or the button to go inside` : `🚪 ${addressOf(near)}: K to knock, L to live here`);
  }
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'k' && near && !inside) knock(near);
    if (k === 'l' && near && !inside) { if (home && idOf(near) === home.id) goIn(); else liveHere(near); }   // L: live here, or go in
  });

  // ---------- every frame ----------
  let poolT = 0;
  function update(dt, onFoot) {
    if ((poolT -= dt) <= 0) { poolT = 0.3; refreshPool(); near = onFoot && !walk ? doorsNear(NEAR)[0] || null : null; ui(); }
    for (const r of pool.values()) if (r.shutIn !== undefined && (r.shutIn -= dt) <= 0) { r.want = 0; delete r.shutIn; }
    for (const r of pool.values()) if (r.angle !== r.want) {
      const s = Math.sign(r.want - r.angle);
      r.angle = s > 0 ? Math.min(r.want, r.angle + dt * 2.6) : Math.max(r.want, r.angle - dt * 2.6); r.leaf.rotation.y = r.angle;
    }
    if (!walk) return false;
    // stepping through the door: wait for it to open, walk, then let it close
    const w = walk; w.t += dt;
    const k = THREE.MathUtils.smoothstep(w.t, 0.45, 1.6);
    player.position.x = w.from[0] + (w.to[0] - w.from[0]) * k; player.position.z = w.from[1] + (w.to[1] - w.from[1]) * k;
    player.rotation.y = w.dir === 'in' ? w.d.yaw + Math.PI : w.d.yaw;
    if (w.dir === 'out' && w.t > 0.3) inside = false;
    if (w.t > 1.7) {
      walk = null; swing(home.id, false);
      if (w.dir === 'in') { inside = true; note(`🏠 You're home. Knocks at ${home.label} will reach you.`); }
      else note('👋 You step outside.');
      shown = ''; ui();
    }
    return true;
  }

  if (new URLSearchParams(location.search).get('home') === 'out') setTimeout(() => { if (homeDoor()) comeOut(); }, 2500);

  // someone else going in or out of a house (pose 5 in their state): open the real door next to
  // them for a moment, so people at the door see it happen
  function openNear(x, z) {
    let best = null, bd = 2.6;
    for (const r of pool.values()) { const d = Math.hypot(r.d.x - x, r.d.z - z); if (d < bd) { bd = d; best = r; } }
    if (best) { best.want = OPEN; best.shutIn = 1.6; }
  }

  return {
    update, openNear,
    get openDoors() { return [...pool.values()].filter(r => r.angle > 0.1).length; },
    get inside() { return inside; },
    get busy() { return !!walk; },
    get home() { return home; },
    // the flat door instances of a square, so they can be hidden under real doors
    adopt(tile, data, mesh) { tile.doors = data; tile.doorMesh = mesh; },
    release(tile) { for (const [id, r] of [...pool]) if (r.tile === tile) dropDoor(id); tile.doors = tile.doorMesh = null; },
    connect(p) { presence = p; listen(); },
    knock: () => knock(near), goIn, comeOut, liveHere: () => near && liveHere(near),
  };
}
