// Car radio: Dutch public radio streams that play while you sit in a car.
//
//   const radio = createRadio();
//   radio.update(driving.driving);   // each frame (cheap): plays only while in a car
//   radio.next(); radio.prev(); radio.toggle();
//   radio.station -> { name, url } | null (off);  radio.on -> boolean
//   mountRadio(container) -> a "📻 NPO Radio 2" button that cycles stations
//
// A plain <audio> element, not Web Audio: the streams are cross-origin without CORS headers and a
// MediaElementSource would only produce silence. Autoplay: the stream starts from a user action
// (the radio button, a key) or, when you get into a car, only if the radio was already on earlier.
// The chosen station survives a reload (localStorage 'toycity.radio').

export const STATIONS = [
  { name: 'NPO Radio 2', url: 'https://icecast.omroep.nl/radio2-bb-mp3' },
  { name: 'NPO 3FM', url: 'https://icecast.omroep.nl/3fm-bb-mp3' },
  { name: 'NPO Radio 1', url: 'https://icecast.omroep.nl/radio1-bb-mp3' },
  { name: 'NPO Klassiek', url: 'https://icecast.omroep.nl/radio4-bb-mp3' },
  { name: 'off', url: null },
];
const KEY = 'toycity.radio';

export function createRadio({ stations = STATIONS, volume = 0.35, fade = 0.5, storage = KEY, Audio: AudioCtor } = {}) {
  const OFF = stations.findIndex(s => !s.url);
  const live = stations.filter(s => s.url).length;
  // idx: the entry shown (may be 'off'); last: the station you listened to before switching off
  let idx = OFF, last = 0, inCar = false, audio = null, signal = true, errors = 0, ramp = null, fading = false;
  const listeners = new Set();
  const changed = () => { for (const f of listeners) try { f(api); } catch (e) { console.warn('radio listener', e); } };

  // remembered choice
  try {
    const s = JSON.parse(localStorage.getItem(storage) || 'null');
    if (s) {
      const i = stations.findIndex(x => x.name === s.station);
      if (i >= 0) last = i;
      if (s.on && stations[last].url) idx = last;
    }
  } catch { /* no storage: fresh start */ }
  const save = () => { try { localStorage.setItem(storage, JSON.stringify({ station: stations[last].name, on: idx !== OFF })); } catch { /* private mode */ } };

  function element() {
    if (audio) return audio;
    const A = AudioCtor || globalThis.Audio;
    if (!A) return null;
    audio = new A();
    audio.preload = 'none'; audio.crossOrigin = null; audio.volume = 0;
    audio.addEventListener('playing', () => { errors = 0; if (!signal) { signal = true; changed(); } });
    audio.addEventListener('error', onError);
    return audio;
  }
  function onError() {
    if (!audio || idx === OFF || !inCar) return;
    if (audio.error && audio.error.code === 1) return;   // MEDIA_ERR_ABORTED: we changed src ourselves
    signal = false; changed();
    // try the next station, but never go round in circles when the internet is gone
    if (++errors >= live) { errors = 0; idx = OFF; save(); apply(); changed(); return; }
    next();
  }

  // volume ramps in JS (a stream has no gain node): rampTo(target, then?)
  function rampTo(target, then) {
    if (!audio) return then && then();
    clearInterval(ramp);
    const step = 1000 / 30, from = audio.volume, t0 = performance.now(), ms = Math.max(1, fade * 1000);
    ramp = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      audio.volume = from + (target - from) * k;
      if (k >= 1) { clearInterval(ramp); ramp = null; then && then(); }
    }, step);
  }

  // make the element match the state: playing the chosen station while in a car, else paused
  function apply() {
    const want = inCar && idx !== OFF ? stations[idx].url : null;
    if (!want) {
      if (!audio) return;
      const clear = () => { if (idx === OFF && audio.getAttribute('src')) { audio.removeAttribute('src'); audio.load(); } };
      if (!audio.paused && !fading) { fading = true; rampTo(0, () => { fading = false; audio.pause(); clear(); }); }
      else if (audio.paused && !fading) clear();
      return;
    }
    const a = element(); if (!a) return;
    fading = false; clearInterval(ramp); ramp = null;
    if (a.getAttribute('src') !== want) { a.setAttribute('src', want); a.load(); }
    a.volume = Math.min(a.volume, volume);
    const p = a.play();
    if (p && p.catch) p.catch(e => { if (e && e.name === 'NotAllowedError') { /* no user gesture yet: the next tap starts it */ } else if (e && e.name !== 'AbortError') console.warn('radio', e); });
    rampTo(volume);
  }

  function set(i) { idx = ((i % stations.length) + stations.length) % stations.length; if (idx !== OFF) last = idx; signal = true; errors = idx === OFF ? 0 : errors; save(); apply(); changed(); }
  function next() { set(idx + 1); }
  function prev() { set(idx - 1); }
  function toggle() { set(idx === OFF ? last : OFF); }

  const api = {
    update(car) { car = !!car; if (car === inCar) return; inCar = car; apply(); changed(); },
    next, prev, toggle, set,
    get station() { return idx === OFF ? null : stations[idx]; },
    get on() { return idx !== OFF; },
    get inCar() { return inCar; },
    get signal() { return signal; },
    get label() { return idx === OFF ? '📻 off' : signal ? '📻 ' + stations[idx].name : '📻 no signal'; },
    get element() { return audio; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    dispose() { clearInterval(ramp); listeners.clear(); if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; } },
  };
  return api;
}

// A button in `container` (any element): shows the station, click = next station. Hidden while you
// are not in a car. Returns the button; the caller styles it (see city.html's #apbtn look).
export function mountRadio(container, radio, { id = 'radiobtn' } = {}) {
  const btn = document.createElement('button');
  btn.id = id; btn.type = 'button'; btn.title = 'Radio: next station'; btn.setAttribute('aria-label', 'Car radio');
  const draw = () => { btn.textContent = radio.label; btn.hidden = !radio.inCar; btn.setAttribute('aria-pressed', radio.on); };
  btn.addEventListener('click', e => { e.stopPropagation(); radio.next(); });
  btn.addEventListener('contextmenu', e => { e.preventDefault(); radio.prev(); });
  const off = radio.onChange(draw);
  draw(); container.appendChild(btn);
  btn.unmount = () => { off(); btn.remove(); };
  return btn;
}
