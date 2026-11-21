// A quick check: start the server as an MCP client would, join, walk, run, drive, and try the limits.
// TOYCITY_URL=http://localhost:8765/ node tools/mcp/try.mjs
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'try', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const t0 = Date.now(), r = await c.callTool({ name, arguments: args });
  const out = r.content.map(x => x.type === 'text' ? x.text : `[${x.type}, ${x.data.length} bytes]`).join('\n');
  console.log(`\n> ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)\n${out}`); return out;
};
console.log('tools:', (await c.listTools()).tools.map(t => t.name).join(', '));
await call('join', { town: 'barendrecht', near: 'Dorpsstraat 141', name: 'Tester' });
await call('walk_to', { place: 'Gemeentehuis Barendrecht' });            // too far on foot
await call('walk_to', { place: 'Kerkweg', run: true });
await call('wait', { seconds: 15 });
await call('wait', { seconds: 20 });
await call('see');
await call('walk', { bearing: 90, metres: 10 });
await call('look');
await call('leave');
process.exit(0);
