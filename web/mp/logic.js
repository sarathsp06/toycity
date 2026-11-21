// Pure multiplayer logic, no browser APIs: room choice, movement smoothing and the voice range
// state machine. Tested by tests/mp.test.mjs.

// Rooms are squares of the RD grid. The player is in the square under them, plus any neighbouring
// square within `edge` metres. Squares already joined are kept until `leave` metres away.
export function roomsFor(X, Y, size, edge, leave, current = new Set()) {
  const i = Math.floor(X / size), j = Math.floor(Y / size), out = new Set();
  for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) {
    const dx = Math.max(a * size - X, 0, X - (a + 1) * size), dy = Math.max(b * size - Y, 0, Y - (b + 1) * size);
    const d = Math.hypot(dx, dy), key = a + '_' + b;
    if (d <= edge || (current.has(key) && d <= leave)) out.add(key);
  }
  return out;
}

// Interpolation buffer for one remote player. Samples are stamped with the local receive time;
// the player is drawn `delay` seconds in the past, between the two samples around that moment.
// Out-of-order and duplicate samples (same or older sequence number) are dropped.
export class Track {
  constructor(delay) { this.delay = delay; this.samples = []; this.seq = -1; }
  push(seq, t, s) {
    if (seq <= this.seq) return false;
    this.seq = seq; this.samples.push({ t, ...s });
    while (this.samples.length > 2 && this.samples[1].t < t - 2) this.samples.shift();
    return true;
  }
  sample(now) {
    const S = this.samples, t = now - this.delay;
    if (!S.length) return null;
    if (t <= S[0].t) return { ...S[0] };
    for (let k = 0; k < S.length - 1; k++) {
      const a = S[k], b = S[k + 1];
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / ((b.t - a.t) || 1);
        let dh = b.h - a.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: a.h + dh * f, v: a.v + (b.v - a.v) * f };
      }
    }
    return { ...S[S.length - 1] };   // no newer sample yet: hold the last known state
  }
}

// Visibility with hysteresis; a function so a camera-frustum test can replace it later.
export function visible(wasVisible, dist, show, hide) { return wasVisible ? dist <= hide : dist <= show; }

export function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24); }
