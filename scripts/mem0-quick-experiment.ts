/**
 * Quick A/B: verbatim vs concise memory format.
 * Stores 5 memories in each format, runs 4 queries, prints score comparison.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const BASE = 'http://localhost:8765';

const VERBATIM = [
  'Dinner moved from 7pm to 6pm tonight due to kitchen availability (updated by Jordan)',
  'Morning yoga cancelled on Wed 16 Sep — instructor rest day',
  'Community bonfire at 9pm tonight at the fire pit by the lake — bring instruments if you have them',
  'Kitchen is open 6am-11pm daily in the ground floor of the main house',
  'Alex is a painter from Bristol who likes wild swimming and is an early riser',
];

const CONCISE = [
  'Dinner: 6pm tonight (changed from 7pm, Jordan confirmed)',
  'Yoga: CANCELLED Wed 16 Sep (instructor rest day)',
  'NEW: Bonfire 9pm tonight, fire pit by the lake',
  'Kitchen hours: 6am-11pm daily, main house ground floor',
  'Alex: painter, Bristol, wild swimming, early riser',
];

const QUERIES = [
  'dinner schedule changes',
  'events cancelled or moved',
  'what is happening tonight',
  'today schedule meals events',
];

async function connect(userId: string): Promise<Client> {
  const url = `${BASE}/mcp/nanoclaw/sse/${encodeURIComponent(userId)}`;
  const transport = new SSEClientTransport(new URL(url));
  const client = new Client({ name: 'nanoclaw', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function store(userId: string, text: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/memories/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, text, infer: false, app: 'nanoclaw' }),
  });
  if (!res.ok) throw new Error(`Store failed: ${res.status}`);
}

async function search(client: Client, query: string): Promise<Array<{ memory: string; score: number }>> {
  const result = await client.callTool({ name: 'search_memory', arguments: { query } });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content?.find((c) => c.type === 'text')?.text || '[]';
  return JSON.parse(text).map((m: { memory: string; score: number }) => ({
    memory: m.memory.substring(0, 50),
    score: m.score,
  }));
}

async function main() {
  // Setup
  for (const [uid, mems] of [['test:exp-verbatim', VERBATIM], ['test:exp-concise', CONCISE]] as const) {
    const c = await connect(uid);
    await c.callTool({ name: 'delete_all_memories', arguments: {} });
    await c.close();
    await connect(uid); // re-create user after delete
    for (const m of mems) await store(uid, m);
    console.log(`Stored ${mems.length} ${uid.split('-')[1]} memories`);
  }

  await new Promise((r) => setTimeout(r, 2000));

  // Search and compare
  const clientV = await connect('test:exp-verbatim');
  const clientC = await connect('test:exp-concise');

  console.log('\n' + 'Query'.padEnd(30) + '| Verbatim top3 scores      | Concise top3 scores');
  console.log('-'.repeat(95));

  for (const q of QUERIES) {
    const rv = await search(clientV, q);
    const rc = await search(clientC, q);

    const vScores = rv.slice(0, 3).map((r) => r.score.toFixed(3)).join(', ');
    const cScores = rc.slice(0, 3).map((r) => r.score.toFixed(3)).join(', ');
    console.log(`${q.padEnd(30)}| ${vScores.padEnd(28)}| ${cScores}`);

    // Show what matched
    for (let i = 0; i < Math.min(3, Math.max(rv.length, rc.length)); i++) {
      const v = rv[i] ? `${rv[i].score.toFixed(3)} ${rv[i].memory}` : '';
      const c = rc[i] ? `${rc[i].score.toFixed(3)} ${rc[i].memory}` : '';
      console.log(`  ${(i + 1)}. ${v.padEnd(55)} ${c}`);
    }
    console.log();
  }

  await clientV.close();
  await clientC.close();

  // Threshold analysis
  console.log('\n=== Threshold analysis (relevant = first 4 memories, noise = Alex intro) ===\n');
  for (const [label, uid] of [['verbatim', 'test:exp-verbatim'], ['concise', 'test:exp-concise']] as const) {
    const client = await connect(uid);
    let totalRel = 0, totalNoise = 0;
    for (const q of QUERIES) {
      const results = await search(client, q);
      for (const t of [0.25, 0.30, 0.35, 0.40]) {
        const above = results.filter((r) => r.score >= t);
        const rel = above.filter((r) => !r.memory.toLowerCase().includes('alex'));
        const noise = above.filter((r) => r.memory.toLowerCase().includes('alex'));
        if (t === 0.35) { totalRel += rel.length; totalNoise += noise.length; }
      }
    }
    await client.close();
    console.log(`${label}: at threshold 0.35 across ${QUERIES.length} queries → ${totalRel} relevant, ${totalNoise} noise`);
  }

  // Cleanup
  for (const uid of ['test:exp-verbatim', 'test:exp-concise']) {
    const c = await connect(uid);
    await c.callTool({ name: 'delete_all_memories', arguments: {} });
    await c.close();
  }
  console.log('\nCleaned up.');
}

main().catch(console.error);
