import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const userId = process.argv[2] || 'community:sim-stress-event-changes';
const sseUrl = `http://localhost:8765/mcp/nanoclaw/sse/${encodeURIComponent(userId)}`;

async function main() {
  const transport = new SSEClientTransport(new URL(sseUrl));
  const client = new Client({ name: 'nanoclaw', version: '1.0.0' });
  await client.connect(transport);

  const result = await client.callTool({ name: 'list_memories', arguments: {} });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content?.find((c) => c.type === 'text')?.text || '';
  const parsed = JSON.parse(text);

  console.log(`Total memories for ${userId}: ${parsed.length}\n`);
  for (const m of parsed) {
    const updated = m.updated_at ? ` (updated: ${m.updated_at})` : '';
    console.log(`  ${m.memory.substring(0, 90)}${updated}`);
  }

  await client.close();
}

main().catch(console.error);
