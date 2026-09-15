/**
 * Discover all MCP tools exposed by the local OpenMemory server.
 * Usage: npx tsx scripts/discover-mem0-tools.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const SSE_URL = 'http://localhost:8765/mcp/nanoclaw/sse/test-discovery';

async function main() {
  console.log(`Connecting to ${SSE_URL} ...`);

  const transport = new SSEClientTransport(new URL(SSE_URL));
  const client = new Client({ name: 'nanoclaw', version: '1.0.0' });

  await client.connect(transport);
  console.log('Connected.\n');

  const { tools } = await client.listTools();

  console.log(`Found ${tools.length} tool(s):\n`);

  for (const tool of tools) {
    console.log(`=== ${tool.name} ===`);
    if (tool.description) {
      console.log(`Description: ${tool.description}`);
    }
    console.log('Input schema:');
    console.log(JSON.stringify(tool.inputSchema, null, 2));
    console.log();
  }

  await client.close();
  console.log('Disconnected.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
