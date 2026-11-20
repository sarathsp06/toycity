// Environmental sound, made in the browser from noise and oscillators: no sound files, no
// network. Four layers mixed by what is around the player (from surroundings(), 0..1 each):
//   wind    always, a slow gusting band of noise
//   leaves  rustle that grows with the number of trees nearby
//   birds   short chirps, more often where it is green
//   traffic a low rumble, louder near streets with many parked cars
// Starts with the first click or key press (browsers block sound before that), off with the button.
export function createAmbience({ ctx, surroundings }) {
  const out = ctx.createGain(); out.gain.value = 0; out.connect(ctx.destination);
  let on = localStorage.getItem('toycity.sound') !== 'off', started = false, envT = 0, birdT = 1;
  const env = { green: 0.5, street: 0.3 };

  const noise = (kind) => {
    const n = ctx.sampleRate * 4, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; d[i] = kind === 'brown' ? (last = (last + 0.02 * w) / 1.02) * 3.5 : w; }
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; return s;
  };
  const layer = (src, type, freq, q) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; src.connect(f).connect(g).connect(out); return { f, g }; };

  let wind, leaves, traffic, gust;
  function startSound() {
    if (started) return; started = true;
    const w = noise('white'), b = noise('brown');
    wind = layer(w, 'bandpass', 500, 0.6);
    leaves = layer(w, 'highpass', 3500, 0.7);
    traffic = layer(b, 'lowpass', 220, 0.5);
    gust = ctx.createOscillator(); gust.frequency.value = 0.07;
    const gd = ctx.createGain(); gd.gain.value = 250; gust.connect(gd).connect(wind.f.frequency);
    w.start(); b.start(); gust.start();
  }
  const begin = () => { if (on) { if (ctx.state !== 'running') ctx.resume(); startSound(); } };
  addEventListener('pointerdown', begin, { once: false }); addEventListener('keydown', begin);

  function chirp(t) {
    const o = ctx.createOscillator(), g = ctx.createGain(), base = 2200 + Math.random() * 1800, n = 2 + Math.floor(Math.random() * 4);
    o.type = 'sine'; o.connect(g).connect(out); g.gain.value = 0;
    for (let k = 0; k < n; k++) {
      const s = t + k * 0.12;
      o.frequency.setValueAtTime(base, s); o.frequency.exponentialRampToValueAtTime(base * (1.3 + Math.random() * 0.4), s + 0.07);
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.01, s + 0.01);   // birds: a fifth of the first version (0.05), they were too loud g.gain.linearRampToValueAtTime(0, s + 0.08);
    }
    o.start(t); o.stop(t + n * 0.12 + 0.1);
  }

  function update(dt) {
    if (!started) return;
    const t = ctx.currentTime;
    out.gain.setTargetAtTime(on ? 0.6 : 0, t, 0.3);
    if (!on) return;
    if ((envT -= dt) <= 0) { envT = 2; Object.assign(env, surroundings()); }
    wind.g.gain.setTargetAtTime(0.025, t, 1);
    leaves.g.gain.setTargetAtTime(0.006 + 0.02 * env.green, t, 1);
    traffic.g.gain.setTargetAtTime(0.02 + 0.12 * env.street, t, 1);
    if ((birdT -= dt) <= 0) { birdT = 0.6 + Math.random() * (6 - 5 * env.green); if (Math.random() < 0.3 + 0.6 * env.green) chirp(t + 0.05); }
  }

  return {
    update,
    get on() { return on; },
    toggle() { on = !on; localStorage.setItem('toycity.sound', on ? 'on' : 'off'); if (on) begin(); },
  };
}
