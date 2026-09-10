/**
 * Functional Tests — Slash Commands with Real Mem0
 *
 * Unlike behavioral tests (which stub tools), these hit real Mem0.
 * Supports both self-hosted (MEM0_SSE_URL) and cloud (MEM0_API_KEY) backends
 * via the shared mem0-client.ts router.
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY env var
 *   - MEM0_SSE_URL or MEM0_API_KEY env var
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
import {
  storeMemory,
  searchMemories,
  deleteMemoriesByUser,
  closeMem0,
} from '../../src/mem0-client.js';
import { expectJudge } from '../helpers/ai-judge.js';

// ── Skip if missing keys ────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAS_MEM0 = !!(process.env.MEM0_SSE_URL || process.env.MEM0_API_KEY);
const describeFn = API_KEY && HAS_MEM0 ? describe : describe.skip;

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

// Tool handler — routes LLM tool calls to the shared Mem0 client
async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'add_memory') {
    const userId = input.user_id as string;
    const text = input.text as string;
    const metadata = (input.metadata as Record<string, string>) || {};
    const actualUserId = userId.startsWith('community:') ? COMMUNITY_NS
      : userId.startsWith('tg:') ? PERSONAL_NS
      : userId;
    await storeMemory(text, actualUserId, metadata);
    return { status: 'ok' };
  }

  if (name === 'search_memories') {
    const userId = input.user_id as string;
    const query = input.query as string;
    const actualUserId = userId.startsWith('community:') ? COMMUNITY_NS
      : userId.startsWith('tg:') ? PERSONAL_NS
      : userId;
    const results = await searchMemories(query, actualUserId);
    return { results: results.map(r => ({ memory: r.memory, metadata: r.metadata, id: r.id })) };
  }

  if (name === 'delete_memory') {
    // Single-ID delete not available on self-hosted; tests use deleteMemoriesByUser instead
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
    const templatesDir = path.resolve(TEST_DIR, '../../governance/templates');
    const communityTemplate =
      fs.readFileSync(path.join(templatesDir, 'base-template.md'), 'utf-8') +
      '\n\n' +
      fs.readFileSync(path.join(templatesDir, 'group-template.md'), 'utf-8');

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

    console.log(`\n  Seeding test namespace: ${COMMUNITY_NS}`);

    await storeMemory('Yoga sessions every Tuesday and Thursday at 7am in the garden.', COMMUNITY_NS, {
      type: 'fact', topic: 'events', tier: 'operational',
    });
    await storeMemory('Community welcome meeting every Monday at 10am in the common room.', COMMUNITY_NS, {
      type: 'fact', topic: 'events', tier: 'operational',
    });
    await storeMemory('Kitchen is in Building A, ground floor. Open 6am-11pm.', COMMUNITY_NS, {
      type: 'fact', topic: 'spaces', tier: 'operational',
    });
    await storeMemory('Co-working space is in Building B, second floor. Open 24/7.', COMMUNITY_NS, {
      type: 'fact', topic: 'spaces', tier: 'operational',
    });
    await storeMemory('Breakfast: 7:30am-9:00am in main dining area, Building A.', COMMUNITY_NS, {
      type: 'fact', topic: 'meals', tier: 'operational',
    });
    await storeMemory('Dinner: 7:00pm-9:00pm in main dining area. Vegetarian option always available.', COMMUNITY_NS, {
      type: 'fact', topic: 'meals', tier: 'operational',
    });

    await new Promise(r => setTimeout(r, 2000));
    console.log('  Seeding complete.\n');
  }, 60000);

  afterAll(async () => {
    console.log(`\n  Cleaning up test namespaces...`);
    await deleteMemoriesByUser(COMMUNITY_NS);
    await deleteMemoriesByUser(PERSONAL_NS);
    await closeMem0();
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

      await expectJudge(client, 'mentions yoga schedule details (days, time, or location)', output);
    }, 30000);

    it('finds seeded spaces', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall kitchen' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      await expectJudge(client, 'mentions kitchen location in Building A with details (hours or floor)', output);
    }, 30000);

    it('returns nothing gracefully for unknown topic', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall underwater basket weaving' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      await expectJudge(client, 'indicates it has no information about the topic (does not hallucinate)', output);
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

      await expectJudge(client, 'mentions Building A as the kitchen location', output);
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

      await expectJudge(client, 'mentions yoga or morning activity relevant to Tuesday', output);
    }, 30000);

    it('shows Monday events', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/today' },
      ], { date: '2026-03-30', day: 'Monday' });

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      await expectJudge(client, 'mentions the welcome meeting or community gathering on Monday', output);
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

      await expectJudge(client, 'mentions Zara and ceramics from her introduction', output);
    }, 60000);
  });

  // ── /hello → /connect: introduction enables matching ────

  describe('/hello → /connect: find people by interest', () => {
    it('connects people with shared interests after /hello', async () => {
      await storeMemory('Marco introduced himself: I\'m Marco, a fermentation nerd and home brewer. Love making kimchi and kombucha.', COMMUNITY_NS, {
        type: 'introduction', topic: 'introductions',
      });
      await new Promise(r => setTimeout(r, 2000));

      // /connect fermentation — should find both Zara (from previous test) and Marco
      const connectMsg = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/connect fermentation' },
      ]);

      const result = await chat(systemPrompt, connectMsg);
      const output = visibleText(result);

      await expectJudge(client, 'mentions Zara or Marco in relation to fermentation', output);
    }, 30000);
  });

  // ── /forget: delete and verify gone ─────────────────────

  describe('/forget → verify gone: delete then search', () => {
    it('removes memories and search no longer finds them', async () => {
      // Use a dedicated namespace so deleteAll only affects this test
      const forgetNs = `community:${TEST_RUN_ID}-forget`;

      await storeMemory(
        'TestUser introduced themselves: Hi, I\'m TestUser, into origami and kite-building.',
        forgetNs,
        { type: 'introduction', topic: 'introductions' },
      );
      await new Promise(r => setTimeout(r, 2000));

      // Verify findable
      const before = await searchMemories('origami', forgetNs);
      expect(before.some(r => r.memory.toLowerCase().includes('origami'))).toBe(true);

      // Delete all memories in this namespace (= just the one we seeded)
      await deleteMemoriesByUser(forgetNs);
      await new Promise(r => setTimeout(r, 1000));

      // Search should come back empty
      const after = await searchMemories('origami', forgetNs);
      expect(after.filter(r => r.memory.toLowerCase().includes('origami'))).toHaveLength(0);
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

      const searches = result.toolCalls.filter(t => t.name === 'search_memories');
      expect(searches.length).toBeGreaterThanOrEqual(1);
      await expectJudge(client, 'mentions yoga or Tuesday schedule details', output);
    }, 30000);

    it('"where\'s the kitchen?" works like /where kitchen', async () => {
      const messages = formatGroupMessages([
        { sender: 'Sam', senderId: 'tg:200', content: '@Andy where\'s the kitchen?' },
      ]);

      const result = await chat(systemPrompt, messages);
      const output = visibleText(result);

      await expectJudge(client, 'mentions Building A as the kitchen location', output);
    }, 30000);
  });
}, 600000);
