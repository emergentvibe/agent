/**
 * Functional Tests — Slash Commands with Real Mem0
 *
 * Unlike behavioral tests (which stub tools), these hit real Mem0 API.
 * They verify the full loop: command → Claude decides → Mem0 write → Mem0 read → correct output.
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY env var
 *   - MEM0_API_KEY env var
 *   - Network access to both APIs
 *
 * Run:
 *   npx vitest run tests/functional/slash-commands.test.ts
 *
 * Cost: ~$0.30-1.00 per full run (Claude Haiku + Mem0 API calls).
 * Cleanup: uses a unique test namespace, deleted in afterAll.
 */
import { config } from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

config();
import { buildClaudeMd, type ConstitutionData } from '../../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../../governance/sync/config.js';

// ── Skip if missing keys ────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MEM0_KEY = process.env.MEM0_API_KEY;
const describeFn = API_KEY && MEM0_KEY ? describe : describe.skip;

// ── Mem0 REST client ────────────────────────────────────────

const MEM0_API = 'https://api.mem0.ai/v1';

interface Mem0Memory {
  id: string;
  memory: string;
  metadata?: Record<string, string>;
}

async function mem0Add(
  userId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${MEM0_API}/memories/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${MEM0_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: text }],
      user_id: userId,
      metadata: metadata || {},
      infer: false,
    }),
  });
  if (!res.ok) throw new Error(`Mem0 add failed: ${res.status} ${await res.text()}`);
}

async function mem0Search(
  userId: string,
  query: string,
): Promise<Mem0Memory[]> {
  const res = await fetch(`${MEM0_API}/memories/search/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${MEM0_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, user_id: userId }),
  });
  if (!res.ok) throw new Error(`Mem0 search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.results || data || []).map((r: any) => ({
    id: r.id,
    memory: r.memory,
    metadata: r.metadata,
  }));
}

async function mem0List(userId: string): Promise<Mem0Memory[]> {
  const res = await fetch(
    `${MEM0_API}/memories/?user_id=${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Token ${MEM0_KEY}` } },
  );
  if (!res.ok) throw new Error(`Mem0 list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.results || data || []).map((r: any) => ({
    id: r.id,
    memory: r.memory,
    metadata: r.metadata,
  }));
}

async function mem0Delete(id: string): Promise<void> {
  await fetch(`${MEM0_API}/memories/${id}/`, {
    method: 'DELETE',
    headers: { Authorization: `Token ${MEM0_KEY}` },
  });
}

async function mem0DeleteAll(userId: string): Promise<void> {
  const memories = await mem0List(userId);
  for (const m of memories) {
    await mem0Delete(m.id);
  }
}

// ── Test namespace (unique per run, cleaned up after) ────────

const TEST_RUN_ID = `test-${Date.now()}`;
const COMMUNITY_NS = `community:${TEST_RUN_ID}`;
const PERSONAL_NS = `tg:${TEST_RUN_ID}-user1`;

// ── Claude client + tools ───────────────────────────────────

let client: Anthropic;
let systemPrompt: string;

// Tools that actually hit Mem0
const MEM0_TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_memory',
    description: 'Store a memory for later retrieval.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The memory content to store' },
        user_id: { type: 'string', description: 'Namespace — community:{slug} for shared, tg:{id} for personal' },
        metadata: {
          type: 'object',
          description: 'Metadata tags',
          properties: {
            type: { type: 'string', enum: ['wish', 'concern', 'fact', 'norm', 'connection', 'preference', 'introduction'] },
            topic: { type: 'string' },
            tier: { type: 'string', enum: ['operational', 'social', 'constitutional'] },
            source_context: { type: 'string', enum: ['group', 'dm', 'onboarding', 'introduction'] },
            person_name: { type: 'string' },
          },
        },
      },
      required: ['text', 'user_id'],
    },
  },
  {
    name: 'search_memories',
    description: 'Search stored memories by query and namespace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        user_id: { type: 'string', description: 'Namespace to search' },
      },
      required: ['query', 'user_id'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a specific memory by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        memory_id: { type: 'string', description: 'The memory ID to delete' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to the chat immediately.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Message to send' },
      },
      required: ['text'],
    },
  },
];

// Real tool handler — routes to Mem0 API
async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'add_memory') {
    const userId = input.user_id as string;
    const text = input.text as string;
    const metadata = (input.metadata as Record<string, unknown>) || {};
    // Rewrite namespace: model uses community:heliotrope, we redirect to test namespace
    const actualUserId = userId.startsWith('community:') ? COMMUNITY_NS
      : userId.startsWith('tg:') ? PERSONAL_NS
      : userId;
    await mem0Add(actualUserId, text, metadata);
    return { status: 'ok' };
  }

  if (name === 'search_memories') {
    const userId = input.user_id as string;
    const query = input.query as string;
    const actualUserId = userId.startsWith('community:') ? COMMUNITY_NS
      : userId.startsWith('tg:') ? PERSONAL_NS
      : userId;
    const results = await mem0Search(actualUserId, query);
    return { results: results.map(r => ({ memory: r.memory, metadata: r.metadata, id: r.id })) };
  }

  if (name === 'delete_memory') {
    const memoryId = input.memory_id as string;
    await mem0Delete(memoryId);
    return { status: 'deleted' };
  }

  if (name === 'send_message') {
    return { status: 'sent' };
  }

  return { status: 'unknown_tool' };
}

// ── Multi-turn chat (same pattern as behavioral, but real tools) ──

async function chat(
  system: string,
  userMessage: string,
  maxTurns = 8,
): Promise<{
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
}> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
  let allText = '';
  const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: unknown }> = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      tools: MEM0_TOOLS,
      messages,
    });

    const turnText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    allText += turnText;

    const turnToolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (response.stop_reason === 'end_turn' || turnToolUses.length === 0) {
      break;
    }

    // Execute tool calls against real Mem0
    messages.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of turnToolUses) {
      const result = await handleToolCall(toolUse.name, toolUse.input as Record<string, unknown>);
      allToolCalls.push({ name: toolUse.name, input: toolUse.input as Record<string, unknown>, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { text: allText, toolCalls: allToolCalls };
}

// Helper: get all visible text (text output + send_message calls)
function visibleText(result: { text: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> }): string {
  return [
    result.text,
    ...result.toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
  ].join(' ').replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

// ── Context setup ───────────────────────────────────────────

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname);

function formatGroupMessages(
  messages: Array<{ sender: string; senderId: string; content: string; time?: string }>,
  dateOverride?: { date: string; day: string },
): string {
  const lines = messages.map(m => {
    const time = m.time || '10:00 AM';
    return `<message sender="${m.sender}" sender_id="${m.senderId}" time="${time}">${m.content}</message>`;
  });
  const currentDate = dateOverride?.date || '2026-03-31';
  const currentDay = dateOverride?.day || 'Tuesday';
  return `<context timezone="Europe/Athens" current_date="${currentDate}" current_day="${currentDay}" />\n<messages>\n${lines.join('\n')}\n</messages>`;
}

// ── Tests ───────────────────────────────────────────────────

describeFn('Functional: Slash Commands with Real Mem0', () => {
  beforeAll(async () => {
    client = new Anthropic({ apiKey: API_KEY });

    // Build system prompt from real templates
    const communityTemplate = fs.readFileSync(
      path.resolve(TEST_DIR, '../../governance/templates/claude-md-template.md'),
      'utf-8',
    );

    const globalClaudeMd = fs.readFileSync(
      path.resolve(TEST_DIR, '../../groups/global/CLAUDE.md'),
      'utf-8',
    );

    const mockGroup: GroupConfig = {
      folder: 'heliotrope',
      slug: 'heliotrope',
      community_name: 'Heliotrope',
      admin_id: 'tg:999',
      admin_name: 'Admin',
      community_start_date: '2026-03-15',
    };

    const mockData: ConstitutionData = {
      slug: 'heliotrope',
      name: 'Heliotrope Constitution',
      content: '## Article 1: Respect\nTreat all community members with dignity.',
      version: '1.0.0',
      content_hash: 'test123',
      updated_at: '2026-03-15T12:00:00Z',
    };

    const communityClaudeMd = buildClaudeMd(
      communityTemplate,
      mockGroup,
      mockData,
      'https://emergentvibe.com',
    );

    systemPrompt = [communityClaudeMd, '\n---\n', globalClaudeMd].join('\n');

    // Seed base knowledge into the test namespace
    console.log(`\n  Seeding test namespace: ${COMMUNITY_NS}`);

    await mem0Add(COMMUNITY_NS, 'Yoga sessions every Tuesday and Thursday at 7am in the garden.', {
      type: 'fact', topic: 'events', tier: 'operational',
    });
    await mem0Add(COMMUNITY_NS, 'Community welcome meeting every Monday at 10am in the common room.', {
      type: 'fact', topic: 'events', tier: 'operational',
    });
    await mem0Add(COMMUNITY_NS, 'Kitchen is in Building A, ground floor. Open 6am-11pm.', {
      type: 'fact', topic: 'spaces', tier: 'operational',
    });
    await mem0Add(COMMUNITY_NS, 'Co-working space is in Building B, second floor. Open 24/7.', {
      type: 'fact', topic: 'spaces', tier: 'operational',
    });
    await mem0Add(COMMUNITY_NS, 'Breakfast: 7:30am-9:00am in main dining area, Building A.', {
      type: 'fact', topic: 'meals', tier: 'operational',
    });
    await mem0Add(COMMUNITY_NS, 'Dinner: 7:00pm-9:00pm in main dining area. Vegetarian option always available.', {
      type: 'fact', topic: 'meals', tier: 'operational',
    });

    // Give Mem0 a moment to index
    await new Promise(r => setTimeout(r, 2000));

    console.log('  Seeding complete.\n');
  }, 60000);

  afterAll(async () => {
    // Clean up both test namespaces
    console.log(`\n  Cleaning up test namespaces...`);
    await mem0DeleteAll(COMMUNITY_NS);
    await mem0DeleteAll(PERSONAL_NS);
    console.log('  Cleanup complete.\n');
  }, 30000);

  // ── /recall: search seeded knowledge ────────────────────

  describe('/recall — searches real Mem0', () => {
    it('finds seeded events', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall yoga' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      // Should have searched Mem0
      const searches = result.toolCalls.filter(t => t.name === 'search_memories');
      expect(searches.length).toBeGreaterThanOrEqual(1);

      // Should contain info from the seeded yoga event
      expect(output.toLowerCase()).toMatch(/yoga/i);
      expect(output.toLowerCase()).toMatch(/tuesday|thursday|7\s*am|garden/i);
    }, 30000);

    it('finds seeded spaces', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall kitchen' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      expect(output.toLowerCase()).toMatch(/building a/i);
      expect(output.toLowerCase()).toMatch(/6am|11pm|ground floor/i);
    }, 30000);

    it('returns nothing gracefully for unknown topic', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall underwater basket weaving' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      // Should not hallucinate
      expect(output.toLowerCase()).toMatch(/don.t have|no.*info|nothing|haven.t/i);
    }, 30000);
  });

  // ── /where: find a location ─────────────────────────────

  describe('/where — location lookup from real Mem0', () => {
    it('finds the kitchen', async () => {
      const messages = formatGroupMessages([
        { sender: 'Sam', senderId: 'tg:200', content: '/where kitchen' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      expect(output.toLowerCase()).toMatch(/building a/i);
    }, 30000);
  });

  // ── /today: schedule for the day ────────────────────────

  describe('/today — schedule from real Mem0', () => {
    it('shows Tuesday events', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/today' },
      ], { date: '2026-03-31', day: 'Tuesday' });

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      // Should mention yoga (Tuesday event)
      expect(output.toLowerCase()).toMatch(/yoga|7\s*am|garden/i);
    }, 30000);

    it('shows Monday events', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/today' },
      ], { date: '2026-03-30', day: 'Monday' });

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      // Should mention welcome meeting (Monday event)
      expect(output.toLowerCase()).toMatch(/welcome|meeting|10\s*am|common room/i);
    }, 30000);
  });

  // ── /hello → /recall: store then retrieve ───────────────

  describe('/hello → /recall: full write-read loop', () => {
    it('stores introduction, then /recall finds it', async () => {
      // Step 1: /hello
      const helloMsg = formatGroupMessages([
        { sender: 'Zara', senderId: 'tg:300', content: '/hello I\'m Zara, I do ceramics and fermentation. First time at a popup city!' },
      ]);

      const helloResult = await chat(systemPrompt, helloMsg);

      // Verify it stored something
      const addCalls = helloResult.toolCalls.filter(t => t.name === 'add_memory');
      expect(addCalls.length).toBeGreaterThanOrEqual(1);
      const communityAdds = addCalls.filter(t =>
        (t.input.user_id as string).startsWith('community:'),
      );
      expect(communityAdds.length).toBeGreaterThanOrEqual(1);

      // Give Mem0 time to index
      await new Promise(r => setTimeout(r, 3000));

      // Step 2: /recall should find Zara
      const recallMsg = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall ceramics' },
      ]);

      const recallResult = await chat(systemPrompt, recallMsg);
      const output = visibleText(recallResult);

      // Should find Zara's introduction
      expect(output.toLowerCase()).toMatch(/zara/i);
      expect(output.toLowerCase()).toMatch(/ceramics/i);
    }, 60000);
  });

  // ── /hello → /connect: introduction enables matching ────

  describe('/hello → /connect: find people by interest', () => {
    it('connects people with shared interests after /hello', async () => {
      // Seed another introduction via direct Mem0 (faster than going through Claude)
      await mem0Add(COMMUNITY_NS, 'Marco introduced himself: I\'m Marco, a fermentation nerd and home brewer. Love making kimchi and kombucha.', {
        type: 'introduction', topic: 'introductions', person_name: 'Marco',
      });
      await new Promise(r => setTimeout(r, 2000));

      // /connect fermentation — should find both Zara (from previous test) and Marco
      const connectMsg = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/connect fermentation' },
      ]);

      const result = await chat(systemPrompt, connectMsg);
      const output = visibleText(result);

      // Should find at least one of them
      const lower = output.toLowerCase();
      expect(lower).toMatch(/zara|marco/i);
      expect(lower).toMatch(/ferment/i);
    }, 30000);
  });

  // ── /forget: delete and verify gone ─────────────────────

  describe('/forget → /recall: delete then verify gone', () => {
    it('removes introduction and recall no longer finds it', async () => {
      // Seed an introduction we'll delete
      await mem0Add(COMMUNITY_NS, 'TestUser introduced themselves: Hi, I\'m TestUser, into origami and kite-building.', {
        type: 'introduction', topic: 'introductions', person_name: 'TestUser',
      });
      await new Promise(r => setTimeout(r, 2000));

      // Verify it's findable first
      const beforeResults = await mem0Search(COMMUNITY_NS, 'origami');
      const origamiMemory = beforeResults.find(r => r.memory.toLowerCase().includes('origami'));
      expect(origamiMemory).toBeDefined();

      // Delete it directly (simulating what /forget would do)
      await mem0Delete(origamiMemory!.id);
      await new Promise(r => setTimeout(r, 1000));

      // /recall should NOT find it anymore
      const recallMsg = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall origami' },
      ]);

      const result = await chat(systemPrompt, recallMsg);
      const output = visibleText(result);

      // Should NOT mention TestUser or origami from memory
      expect(output.toLowerCase()).not.toMatch(/testuser/i);
      expect(output.toLowerCase()).toMatch(/don.t have|no.*info|nothing|haven.t|not sure/i);
    }, 45000);
  });

  // ── Natural language equivalence ────────────────────────

  describe('Natural language works like slash commands', () => {
    it('"what\'s happening today?" works like /today', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '@Andy what\'s happening today?' },
      ], { date: '2026-03-31', day: 'Tuesday' });

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      // Should search events and return schedule
      const searches = result.toolCalls.filter(t => t.name === 'search_memories');
      expect(searches.length).toBeGreaterThanOrEqual(1);
      expect(output.toLowerCase()).toMatch(/yoga|garden|7\s*am/i);
    }, 30000);

    it('"where\'s the kitchen?" works like /where kitchen', async () => {
      const messages = formatGroupMessages([
        { sender: 'Sam', senderId: 'tg:200', content: '@Andy where\'s the kitchen?' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      expect(output.toLowerCase()).toMatch(/building a/i);
    }, 30000);
  });
}, 600000);
