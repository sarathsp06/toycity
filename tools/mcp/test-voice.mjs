// Two-way conversation test against a local server: the agent (MCP) talks with a browser whose
// microphone plays /tmp/kk3/person.wav, a person who says hello at 4 s, interrupts at 30 s and says
// goodbye at 50 s after the call is answered. Make that file with Kokoro first (python with kokoro-onnx,
// soundfile, numpy; 48 kHz mono 16-bit WAV, e.g. voice am_michael at those offsets), then from tools/mcp:
//   TOYCITY_URL=http://localhost:8765/ TOYCITY_CHROME=<a chromium> node test-voice.mjs
// Expected: listen returns the hello right after it ends; the second say is cut off by "Stop, stop…"
// and returns those words; the third say returns the goodbye as the reply.
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exe = process.env.TOYCITY_CHROME, SITE = process.env.TOYCITY_URL;
const c = new Client({ name: 't', version: '1' }); await c.connect(new StdioClientTransport({ command: 'node', args: ['server.mjs'], env: { ...process.env } }));
const A = async (tool, args = {}) => (await c.callTool({ name: tool, arguments: args })).content.map(x => x.type === 'text' ? x.text : `[${x.type}]`).join(' ');
console.log('join', (await A('join', { town: 'amsterdam', name: 'Vox', voice: true })).split('\n')[0]);
const br = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/kk3/person.wav'] });
const ctx = await br.newContext({ viewport: { width: 900, height: 560 }, permissions: ['microphone'] });
await ctx.addInitScript(() => localStorage.setItem('toycity.name', 'Tester'));
const p = await ctx.newPage();
await p.goto(SITE + 'city.html?place=amsterdam');
for (let i = 0; i < 60; i++) { await p.waitForTimeout(1000); if (await p.evaluate(() => [...document.querySelectorAll('#mpcall .talk')].some(b => b.textContent.includes('Vox')))) break; }
const callP = A('call', { name: 'Tester', wait: 20 });
for (let i = 0; i < 40; i++) { await p.waitForTimeout(500); const b = await p.evaluate(() => { const t = [...document.querySelectorAll('#mptoasts .toast button')].find(b => b.textContent === 'Answer'); t?.click(); return !!t; }); if (b) break; }
const t0 = Date.now(); console.log('call ->', await callP);
const ft = () => ((Date.now() - t0) / 1000).toFixed(1), at = async s => { const w = t0 + s * 1000 - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); };
// 1. the person speaks first (at 4 s): listen should return right after their sentence, not after 20 s
let t = Date.now(); console.log('listen ->', await A('listen', { seconds: 20 }), `(took ${((Date.now() - t) / 1000).toFixed(1)} s, at ${ft()})`);
// 2. the agent answers; nobody replies within 6 s
console.log('say 1 ->', await A('say', { text: 'I am doing well, thank you. The houses here are from the 17th century and many of them lean forward on purpose.', listen_seconds: 6 }), 'at', ft());
// 3. a long answer that the person interrupts at 30 s
await at(27);
console.log('say 2 at', ft(), '->', await A('say', { text: 'Let me tell you about the map. It is made from open data of the Dutch government. Every building has its real height. The trees come from a city register. The roads come from OpenStreetMap. The canals are from the water board.', then_listen: false }), 'at', ft());
// 4. a reply, then wait for their goodbye at 50 s
console.log('say 3 ->', await A('say', { text: 'Sure, the canals. They were dug in the 1600s to move goods by boat.', listen_seconds: 25 }), 'at', ft());
console.log('wait call ->', (await A('wait', { seconds: 3 })).split('\n')[0]);
await A('leave'); await br.close(); process.exit(0);
