/**
 * Systematic experiment: memory format × query style → score matrix.
 * Tests which combination of storage format and query design gives
 * the best retrieval for schedule-related memories.
 *
 * Usage: npx tsx scripts/mem0-query-experiment.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const BASE_URL = 'http://localhost:8765';
const APP = 'nanoclaw';

// --- Memory format variants ---

const FORMATS: Record<string, Array<{ text: string; label: string; relevant: boolean }>> = {
  verbatim: [
    { text: 'Dinner moved from 7pm to 6pm tonight due to kitchen availability (updated by Jordan)', label: 'dinner-change', relevant: true },
    { text: 'Morning yoga cancelled on Wed 16 Sep — instructor rest day', label: 'yoga-cancel', relevant: true },
    { text: 'Community bonfire at 9pm tonight at the fire pit by the lake — bring instruments if you have them', label: 'bonfire-new', relevant: true },
    { text: 'Kitchen is open 6am-11pm daily in the ground floor of the main house', label: 'kitchen-hours', relevant: true },
    { text: 'Sauna is heated from 4pm to 10pm daily', label: 'sauna-hours', relevant: false },
    { text: 'Alex is a painter from Bristol who likes wild swimming', label: 'intro-alex', relevant: false },
    { text: 'Priya is a chef from London interested in fermentation and foraging', label: 'intro-priya', relevant: false },
  ],
  concise: [
    { text: 'Dinner: 6pm tonight (changed from 7pm). Updated by Jordan.', label: 'dinner-change', relevant: true },
    { text: 'Morning yoga: CANCELLED Wed 16 Sep. Instructor rest day.', label: 'yoga-cancel', relevant: true },
    { text: 'NEW: Bonfire 9pm tonight, fire pit by the lake. Bring instruments.', label: 'bonfire-new', relevant: true },
    { text: 'Kitchen hours: 6am-11pm daily, ground floor main house.', label: 'kitchen-hours', relevant: true },
    { text: 'Sauna hours: 4pm-10pm daily.', label: 'sauna-hours', relevant: false },
    { text: 'Alex: painter from Bristol, likes wild swimming.', label: 'intro-alex', relevant: false },
    { text: 'Priya: chef from London, into fermentation and foraging.', label: 'intro-priya', relevant: false },
  ],
  prefixed: [
    { text: '[schedule] Dinner moved from 7pm to 6pm tonight (updated by Jordan)', label: 'dinner-change', relevant: true },
    { text: '[schedule] Morning yoga cancelled Wed 16 Sep — instructor rest day', label: 'yoga-cancel', relevant: true },
    { text: '[schedule] Community bonfire at 9pm tonight at fire pit by the lake', label: 'bonfire-new', relevant: true },
    { text: '[facility] Kitchen open 6am-11pm daily, ground floor main house', label: 'kitchen-hours', relevant: true },
    { text: '[facility] Sauna heated 4pm-10pm daily', label: 'sauna-hours', relevant: false },
    { text: '[person] Alex — painter from Bristol, wild swimming', label: 'intro-alex', relevant: false },
    { text: '[person] Priya — chef from London, fermentation, foraging', label: 'intro-priya', relevant: false },
  ],
};

// --- Query variants ---

const QUERIES: Array<{ name: string; query: string }> = [
  { name: 'old-keyword-soup', query: 'schedule changes Thursday 25 September events times' },
  { name: 'natural-dinner', query: 'dinner schedule changes' },
  { name: 'natural-cancelled', query: 'events cancelled or moved' },
  { name: 'natural-tonight', query: 'what is happening tonight activities events' },
  { name: 'specific-dinner', query: 'dinner time tonight' },
  { name: 'specific-yoga', query: 'yoga class schedule' },
  { name: 'specific-bonfire', query: 'bonfire gathering evening' },
  { name: 'broad-schedule', query: 'today schedule meals events activities' },
  { name: 'prefixed-schedule', query: '[schedule] events today' },
];

// --- Helpers ---

async function ensureUser(userId: string): Promise<void> {
  const sseUrl = `${BASE_URL}/mcp/${APP}/sse/${encodeURIComponent(userId)}`;
  const transport = new SSEClientTransport(new URL(sseUrl));
  const client = new Client({ name: APP, version: '1.0.0' });
  await client.connect(transport);
  await client.close();
}

async function storeMemory(userId: string, text: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/memories/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, text, infer: false, app: APP }),
  });
  if (!res.ok) throw new Error(`Store failed: ${res.status} ${await res.text()}`);
}

async function searchMemories(userId: string, query: string): Promise<Array<{ memory: string; score: number }>> {
  const sseUrl = `${BASE_URL}/mcp/${APP}/sse/${encodeURIComponent(userId)}`;
  const transport = new SSEClientTransport(new URL(sseUrl));
  const client = new Client({ name: APP, version: '1.0.0' });
  await client.connect(transport);

  const result = await client.callTool({ name: 'search_memory', arguments: { query } });
  await client.close();

  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content?.find((c) => c.type === 'text')?.text || '[]';
  const parsed = JSON.parse(text);
  return parsed.map((m: { memory: string; score: number }) => ({
    memory: m.memory,
    score: m.score,
  }));
}

async function deleteAllMemories(userId: string): Promise<void> {
  const sseUrl = `${BASE_URL}/mcp/${APP}/sse/${encodeURIComponent(userId)}`;
  const transport = new SSEClientTransport(new URL(sseUrl));
  const client = new Client({ name: APP, version: '1.0.0' });
  await client.connect(transport);
  await client.callTool({ name: 'delete_all_memories', arguments: {} });
  await client.close();
}

// --- Main experiment ---

async function main() {
  const formatNames = Object.keys(FORMATS);

  // Setup: create users and store memories
  console.log('=== SETUP: Storing memories ===\n');
  for (const fmt of formatNames) {
    const userId = `test:experiment-${fmt}`;
    await ensureUser(userId);
    await deleteAllMemories(userId);
    // Re-ensure after delete (user might be removed)
    await ensureUser(userId);

    for (const mem of FORMATS[fmt]) {
      await storeMemory(userId, mem.text);
    }
    console.log(`  ${fmt}: stored ${FORMATS[fmt].length} memories`);
  }

  // Give Qdrant a moment to index
  await new Promise((r) => setTimeout(r, 2000));

  // Run queries and collect scores
  console.log('\n=== RESULTS: Score matrix ===\n');

  type Result = { format: string; query: string; scores: Array<{ label: string; score: number; relevant: boolean }> };
  const allResults: Result[] = [];

  for (const fmt of formatNames) {
    const userId = `test:experiment-${fmt}`;
    const memories = FORMATS[fmt];

    for (const q of QUERIES) {
      const results = await searchMemories(userId, q.query);

      // Match results back to our known memories by substring match
      const scored = memories.map((mem) => {
        const match = results.find((r) =>
          r.memory.includes(mem.text.substring(0, 30)) ||
          mem.text.includes(r.memory.substring(0, 30))
        );
        return { label: mem.label, score: match?.score ?? 0, relevant: mem.relevant };
      });

      allResults.push({ format: fmt, query: q.name, scores: scored });
    }
  }

  // Print compact matrix: for each query, show relevant memory scores per format
  const relevantLabels = ['dinner-change', 'yoga-cancel', 'bonfire-new', 'kitchen-hours'];
  const noiseLabels = ['sauna-hours', 'intro-alex', 'intro-priya'];

  console.log('Format'.padEnd(12) + 'Query'.padEnd(22) + relevantLabels.map(l => l.padStart(14)).join('') + ' | ' + noiseLabels.map(l => l.padStart(12)).join(''));
  console.log('-'.repeat(12 + 22 + 14 * 4 + 3 + 12 * 3));

  for (const r of allResults) {
    const relScores = relevantLabels.map((l) => {
      const s = r.scores.find((s) => s.label === l);
      return s ? s.score.toFixed(3).padStart(14) : '         n/a ';
    });
    const noiseScores = noiseLabels.map((l) => {
      const s = r.scores.find((s) => s.label === l);
      return s ? s.score.toFixed(3).padStart(12) : '       n/a ';
    });
    console.log(r.format.padEnd(12) + r.query.padEnd(22) + relScores.join('') + ' | ' + noiseScores.join(''));
  }

  // Summary: best format × query combos
  console.log('\n=== ANALYSIS ===\n');

  // For each format, find queries that maximize relevant scores while minimizing noise
  for (const fmt of formatNames) {
    const fmtResults = allResults.filter((r) => r.format === fmt);
    console.log(`\n--- ${fmt} ---`);

    for (const q of fmtResults) {
      const relAvg = q.scores.filter((s) => s.relevant).reduce((sum, s) => sum + s.score, 0) / q.scores.filter((s) => s.relevant).length;
      const noiseMax = Math.max(...q.scores.filter((s) => !s.relevant).map((s) => s.score), 0);
      const gap = relAvg - noiseMax;
      const thresholds = [0.25, 0.30, 0.35, 0.40, 0.50];
      const precision = thresholds.map((t) => {
        const retrieved = q.scores.filter((s) => s.score >= t);
        const truePos = retrieved.filter((s) => s.relevant).length;
        const falsePos = retrieved.filter((s) => !s.relevant).length;
        return `@${t}: ${truePos}rel/${falsePos}noise`;
      });
      console.log(`  ${q.query.padEnd(22)} relAvg=${relAvg.toFixed(3)} noiseMax=${noiseMax.toFixed(3)} gap=${gap.toFixed(3)}  ${precision.join('  ')}`);
    }
  }

  // Cleanup
  console.log('\n=== CLEANUP ===');
  for (const fmt of formatNames) {
    await deleteAllMemories(`test:experiment-${fmt}`);
    console.log(`  Deleted test:experiment-${fmt}`);
  }
}

main().catch(console.error);
