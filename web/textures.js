// Procedural textures for the streamed city, drawn once on canvases and shared by every square.
// Ground texture sizes all divide 500 m, so patterns continue seamlessly across square borders.
import * as THREE from 'three';

import { rng } from './ambient.js';   // the game's one seeded PRNG

const PX = 128; // texture pixels per metre

function canvasTex(wm, hm, draw, renderer, px = PX) {
  const c = document.createElement('canvas'); c.width = Math.round(wm * px); c.height = Math.round(hm * px);
  const g = c.getContext('2d'); draw(g, c.width, c.height, px);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.userData.size = [wm, hm];
  return t;
}
function speckle(g, w, h, n, colors, size = 2) {
  const r = rng(n);
  for (let i = 0; i < n; i++) { g.fillStyle = colors[Math.floor(r() * colors.length)]; g.fillRect(r() * w, r() * h, size, size); }
}

// one floor, 3 m wide: Dutch stretcher-bond brick (windows and doors are separate instances)
export function wallTexture(renderer, base, dark, light) {
  return canvasTex(3, 2.8, (g, w, h) => {
    const r = rng(base.length * 99 + 7);
    g.fillStyle = '#cfc8bd'; g.fillRect(0, 0, w, h);
    const course = 0.0625 * PX, brick = 0.22 * PX;
    for (let row = 0, y = h - course; y > -course; row++, y -= course)
      for (let x = (row % 2) * -brick / 2; x < w; x += brick) {
        const k = r(); g.fillStyle = k < 0.15 ? dark : k > 0.85 ? light : base;
        g.fillRect(x + 1, y + 1, brick - 2, course - 2);
      }
  }, renderer);
}
export const WALLS = [['#8a4a36', '#6e3a2b', '#a35e48'], ['#a8784f', '#8a603e', '#bf8f63'], ['#6b3e30', '#553026', '#7f4b3b'], ['#9b5b3f', '#7d4632', '#b06e50']];

export const SURFACES = {
  road: r => canvasTex(4, 4, (g, w, h) => { g.fillStyle = '#5d6166'; g.fillRect(0, 0, w, h); speckle(g, w, h, 9000, ['#50545a', '#6a6e73', '#474b50', '#777b80']); }, r),
  brickroad: r => canvasTex(2, 2, (g, w, h) => {
    g.fillStyle = '#6e5a4d'; g.fillRect(0, 0, w, h); const q = rng(5), u = 0.125 * PX;
    for (let i = -20; i < 40; i++) for (let j = -20; j < 40; j++) {
      const x = (i - j) * u, y = (i + j) * u;
      g.fillStyle = ['#8f4f3a', '#9a5a43', '#7d4433', '#a3644b'][Math.floor(q() * 4)];
      g.fillRect(x + 1, y + 1, 2 * u - 2, u - 2); g.fillRect(x + 2 * u + 1, y + 1 - u, u - 2, 2 * u - 2);
    } }, r),
  parking: r => canvasTex(2, 2, (g, w, h) => { g.fillStyle = '#6f6c68'; g.fillRect(0, 0, w, h); const q = rng(9), a = 0.25 * PX, b = 0.125 * PX;
    for (let y = 0, row = 0; y < h; y += b, row++) for (let x = (row % 2) * a / 2 - a; x < w; x += a) { g.fillStyle = ['#8a8782', '#7d7a75', '#94918b'][Math.floor(q() * 3)]; g.fillRect(x + 1, y + 1, a - 2, b - 2); } }, r),
  pavement: r => canvasTex(1.25, 1.25, (g, w, h) => { g.fillStyle = '#8f8d88'; g.fillRect(0, 0, w, h); const q = rng(3), s = 0.3125 * PX;
    for (let y = 0; y < h - 1; y += s) for (let x = 0; x < w - 1; x += s) { g.fillStyle = ['#b9b6ae', '#c2bfb7', '#b1aea6'][Math.floor(q() * 3)]; g.fillRect(x + 1.5, y + 1.5, s - 3, s - 3); }
    speckle(g, w, h, 1500, ['rgba(0,0,0,.08)', 'rgba(255,255,255,.12)']); }, r),
  cycle: r => canvasTex(4, 4, (g, w, h) => { g.fillStyle = '#9a4a3e'; g.fillRect(0, 0, w, h); speckle(g, w, h, 8000, ['#8a4136', '#a8564a', '#7e3a30']); }, r),
  grass: r => canvasTex(2.5, 2.5, (g, w, h) => { g.fillStyle = '#5f8f3e'; g.fillRect(0, 0, w, h); speckle(g, w, h, 22000, ['#6b9a46', '#557f36', '#78a652', '#4c7531', '#83ad5c'], 3); }, r),
  yard: r => canvasTex(2.5, 2.5, (g, w, h) => { g.fillStyle = '#6b9446'; g.fillRect(0, 0, w, h); speckle(g, w, h, 19000, ['#77a050', '#5d863d', '#86ad5f', '#8f8a6f'], 3); }, r),
  plants: r => canvasTex(2, 2, (g, w, h) => { g.fillStyle = '#2f5a2a'; g.fillRect(0, 0, w, h); const q = rng(4);
    for (let i = 0; i < 900; i++) { g.fillStyle = ['#3d6e33', '#28502a', '#4a7d3a', '#355f2c', '#6a8f45'][Math.floor(q() * 5)]; g.beginPath(); g.arc(q() * w, q() * h, 4 + q() * 9, 0, 6.3); g.fill(); } }, r),
  sand: r => canvasTex(2, 2, (g, w, h) => { g.fillStyle = '#d9c79f'; g.fillRect(0, 0, w, h); speckle(g, w, h, 9000, ['#cdb98f', '#e4d4ae', '#c4ae84']); }, r),
};
SURFACES.path = SURFACES.brickroad; // front garden paths
SURFACES.paved = SURFACES.pavement; SURFACES.kerbisland = SURFACES.pavement; SURFACES.verge = SURFACES.grass;

export function windowTexture(renderer, lit) {
  return canvasTex(1.3, 1.35, (g, w, h) => {
    const f = 0.08 * PX, q = rng(lit ? 5 : 9);
    g.fillStyle = lit ? '#000' : '#f2f1ec'; g.fillRect(0, 0, w, h);
    for (const [x, y, pw, ph] of [[f, f, w / 2 - f * 1.5, h - 2 * f], [w / 2 + f / 2, f, w / 2 - f * 1.5, h - 2 * f]]) {
      if (lit) {
        const gl = g.createRadialGradient(x + pw / 2, y + ph * 0.6, 4, x + pw / 2, y + ph / 2, ph);
        gl.addColorStop(0, '#ffe2a8'); gl.addColorStop(1, '#c98a3c'); g.fillStyle = gl; g.fillRect(x, y, pw, ph);
        g.fillStyle = 'rgba(120,60,20,.5)'; g.fillRect(x, y, pw * 0.22, ph);
      } else {
        const sky = g.createLinearGradient(0, y, 0, y + ph);
        sky.addColorStop(0, '#a9c1d3'); sky.addColorStop(0.45, '#4d5e6d'); sky.addColorStop(1, '#262d34');
        g.fillStyle = sky; g.fillRect(x, y, pw, ph);
        g.fillStyle = 'rgba(255,255,255,.16)'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + pw * 0.45, y); g.lineTo(x, y + ph * 0.55); g.fill();
        if (q() < 0.5) { g.fillStyle = 'rgba(235,232,222,.55)'; g.fillRect(x, y, pw, ph * 0.18); }
      }
    }
    if (!lit) { g.fillStyle = '#d9d6cc'; g.fillRect(0, h * 0.3, w, f * 0.5); g.fillStyle = '#3b3f44'; g.fillRect(-2, h - 6, w + 4, 6); }
  }, renderer);
}
export function doorTexture(renderer) {
  return canvasTex(1.0, 2.2, (g, w, h) => {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#eeeeee'; g.fillRect(0, 0, w, 0.07 * PX); g.fillRect(0, 0, 0.07 * PX, h); g.fillRect(w - 0.07 * PX, 0, 0.07 * PX, h);
    g.fillStyle = '#9fb6c6'; g.fillRect(0.2 * PX, 0.15 * PX, w - 0.4 * PX, 0.55 * PX);
    g.strokeStyle = '#b4b4b4'; g.lineWidth = 3; g.strokeRect(0.2 * PX, 0.95 * PX, w - 0.4 * PX, 1.0 * PX);
    g.fillStyle = '#5a5a5a'; g.fillRect(0.3 * PX, 0.8 * PX, 0.4 * PX, 0.06 * PX);
    g.fillStyle = '#c9a54a'; g.beginPath(); g.arc(w - 0.18 * PX, 1.1 * PX, 5, 0, 6.3); g.fill();
  }, renderer);
}
export function plankTexture(renderer) {
  return canvasTex(1.25, 1.8, (g, w, h) => {
    const q = rng(21), pw = 0.15625 * PX;
    for (let x = 0; x < w; x += pw) { g.fillStyle = ['#7a5a3c', '#6d4f34', '#856343', '#715538'][Math.floor(q() * 4)]; g.fillRect(x, 0, pw - 2, h); g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x + pw - 2, 0, 2, h); }
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, 0.3 * PX, w, 6); g.fillRect(0, h - 0.35 * PX, w, 6);
  }, renderer);
}
export function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,214,150,1)'); gr.addColorStop(0.35, 'rgba(255,190,110,.45)'); gr.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function plateAtlas(chars) {
  const c = document.createElement('canvas'); c.width = 64 * chars.length; c.height = 96;
  const g = c.getContext('2d'); g.fillStyle = '#1d2b3a'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff'; g.font = 'bold 72px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < chars.length; i++) g.fillText(chars[i], i * 64 + 32, 50);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
