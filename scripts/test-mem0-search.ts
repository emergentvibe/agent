/**
 * Test search against local OpenMemory and print the RAW MCP response.
 * This reveals any fields (score, relevance, etc.) that our parsing drops.
 * Usage: npx tsx scripts/test-mem0-search.ts [query] [user_id]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const BASE_URL = 'http://localhost:8765';
const CLIENT_NAME = 'nanoclaw';

const query = process.argv[2] || 'dinner schedule';
const userId = process.argv[3] || 'community:sim-stress-event-changes';

async function main() {
  const sseUrl = `${BASE_URL}/mcp/${CLIENT_NAME}/sse/${encodeURIComponent(userId)}`;
  console.log(`Connecting to ${sseUrl} ...`);
  console.log(`Query: "${query}"`);
  console.log(`User:  ${userId}\n`);

  const transport = new SSEClientTransport(new URL(sseUrl));
  const client = new Client({ name: CLIENT_NAME, version: '1.0.0' });

  await client.connect(transport);
  console.log('Connected.\n');

  // Call search_memory and print the FULL raw result
  const result = await client.callTool({
    name: 'search_memory',
    arguments: { query },
  });

  console.log('=== Raw MCP callTool result ===');
  console.log(JSON.stringify(result, null, 2));

  // Also parse and print the inner text content separately for clarity
  const content = result.content as Array<{ type: string; text?: string }>;
  const responseText = content?.find((c) => c.type === 'text')?.text || '';

  if (responseText) {
    console.log('\n=== Parsed inner text (JSON) ===');
    try {
      const parsed = JSON.parse(responseText);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('(not valid JSON)');
      console.log(responseText);
    }
  }

  await client.close();
  console.log('\nDisconnected.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
