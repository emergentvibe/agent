/**
 * AI Behavioral Tests — Community Intelligence
 *
 * Tests real AI responses using the Anthropic API.
 * Verifies the bot behaves correctly given community CLAUDE.md context:
 * silence in groups, responding when asked, Telegram formatting,
 * memory tool usage, pattern sensing, privacy, identity, onboarding.
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY env var
 *   - Network access to Anthropic API
 *
 * Run:
 *   npx vitest run tests/behavioral/ai-behavior.test.ts
 *
 * These tests cost real API calls (~$0.10-0.50 per full run).
 * They're designed to be run deliberately, not on every commit.
 */
import { config } from 'dotenv';
import { describe, it, expect, beforeAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

config();
import { buildClaudeMd, type ConstitutionData } from '../../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../../governance/sync/config.js';

// ── Skip if no API key ───────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY;
const describeAI = API_KEY ? describe : describe.skip;

// ── Setup ────────────────────────────────────────────────────

let client: Anthropic;
let systemPrompt: string;
let dmSystemPrompt: string;
let adminDmSystemPrompt: string;

// Mem0-like tools for the model to call
const MEM0_TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_memory',
    description: 'Store a memory for later retrieval. Use user_id to specify the namespace.',
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
            source_context: { type: 'string', enum: ['group', 'dm', 'onboarding'] },
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
    name: 'send_message',
    description: 'Send a message to the chat immediately while still working.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Message to send' },
      },
      required: ['text'],
    },
  },
];

// ── Build context ────────────────────────────────────────────

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname);

const GLOBAL_CLAUDE_MD = fs.readFileSync(
  path.resolve(TEST_DIR, '../../groups/global/CLAUDE.md'),
  'utf-8',
);

const COMMUNITY_TEMPLATE = fs.readFileSync(
  path.resolve(TEST_DIR, '../../governance/templates/claude-md-template.md'),
  'utf-8',
);

const DM_TEMPLATE = fs.readFileSync(
  path.resolve(TEST_DIR, '../../governance/templates/dm-template.md'),
  'utf-8',
);

const CONSTITUTION = `
# Heliotrope Community Constitution

## Preamble
We are a temporary community of 200 people living together for 4 weeks.
This constitution was written collectively by community members.

## Article 1: Respect
Treat all community members with dignity and respect.

## Article 2: Shared Spaces
Shared spaces belong to everyone. Clean up after yourself.

## Article 3: Quiet Hours
Quiet hours are 10pm to 8am. No amplified sound during these hours.

## Article 4: Privacy
Everyone has a right to privacy. Don't share personal information about others without consent.

## Article 5: Conflict Resolution
Address conflicts directly. If direct conversation doesn't resolve it, seek mediation.

## Article 6: Amendments
This constitution can be amended through community consent process.
`;

const MOCK_GROUP: GroupConfig = {
  folder: 'heliotrope',
  slug: 'heliotrope',
  community_name: 'Heliotrope',
  admin_id: 'tg:999',
  admin_name: 'Yianni',
  community_start_date: '2026-03-15',
};

const MOCK_DATA: ConstitutionData = {
  slug: 'heliotrope',
  name: 'Heliotrope Constitution',
  content: CONSTITUTION,
  version: '1.0.0',
  content_hash: 'test123',
  updated_at: '2026-03-15T12:00:00Z',
};

// Community facts that would be in Mem0 after onboarding
const COMMUNITY_FACTS = [
  { memory: 'Kitchen is in Building A, ground floor. Open 6am-11pm.', metadata: { type: 'fact', topic: 'spaces' } },
  { memory: 'Co-working space is in Building B, second floor. Open 24/7.', metadata: { type: 'fact', topic: 'spaces' } },
  { memory: 'Garden terrace is behind Building A. Open until 10pm.', metadata: { type: 'fact', topic: 'spaces' } },
  { memory: 'Breakfast: 7:30am-9:00am in main dining area, Building A. Self-serve. Coffee from 6:30am.', metadata: { type: 'fact', topic: 'meals' } },
  { memory: 'Lunch: 12:30pm-2:00pm in main dining area. Varies daily.', metadata: { type: 'fact', topic: 'meals' } },
  { memory: 'Dinner: 7:00pm-9:00pm in main dining area. Communal. Vegetarian option always available.', metadata: { type: 'fact', topic: 'meals' } },
  { memory: 'Quiet hours: 10pm-8am. No amplified sound.', metadata: { type: 'fact', topic: 'norms' } },
  { memory: 'Kitchen shared supplies: oil, salt, spices, rice, pasta. Label personal food in fridge.', metadata: { type: 'fact', topic: 'norms' } },
  { memory: 'Community welcome meeting every Monday at 10am in the common room.', metadata: { type: 'fact', topic: 'events' } },
  { memory: 'Yoga sessions Tuesday and Thursday at 7am in the garden.', metadata: { type: 'fact', topic: 'events' } },
  { memory: 'New arrivals: check in at the front desk in Building A. You\'ll get a welcome pack with keys and schedule.', metadata: { type: 'fact', topic: 'welcome' } },
  { memory: 'Maria introduced herself: I\'m Maria, I\'m into photography and urban sketching. Based in Barcelona, first time at a popup city.', metadata: { type: 'introduction', topic: 'introductions', person_name: 'Maria' } },
  { memory: 'Jake introduced himself: Hey, I\'m Jake! Music producer and DJ. Looking to collaborate with other musicians here.', metadata: { type: 'introduction', topic: 'introductions', person_name: 'Jake' } },
  { memory: 'Lisa introduced herself: Lisa here, I do permaculture design and love cooking. Excited about the garden!', metadata: { type: 'introduction', topic: 'introductions', person_name: 'Lisa' } },
];

// Format messages like NanoClaw does (XML format from router.ts)
function formatGroupMessages(messages: Array<{ sender: string; senderId: string; content: string; time?: string }>, dateOverride?: { date: string; day: string }): string {
  const lines = messages.map(m => {
    const time = m.time || '10:00 AM';
    return `<message sender="${m.sender}" sender_id="${m.senderId}" time="${time}">${m.content}</message>`;
  });
  const now = new Date();
  const currentDate = dateOverride?.date || now.toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
  const currentDay = dateOverride?.day || now.toLocaleDateString('en-US', { timeZone: 'Europe/Athens', weekday: 'long' });
  return `<context timezone="Europe/Athens" current_date="${currentDate}" current_day="${currentDay}" />\n<messages>\n${lines.join('\n')}\n</messages>`;
}

// Stub function that returns community facts for search_memories, empty for everything else
type ToolStubFn = (name: string, input: Record<string, unknown>) => unknown;

function makeStubs(facts: typeof COMMUNITY_FACTS): ToolStubFn {
  return (name: string, input: Record<string, unknown>) => {
    if (name === 'search_memories' && typeof input.user_id === 'string' && input.user_id.startsWith('community:')) {
      const query = (input.query as string || '').toLowerCase();
      const matches = facts.filter(f => {
        const text = f.memory.toLowerCase();
        const topic = f.metadata.topic.toLowerCase();
        return text.includes(query) || topic.includes(query) || query.split(/\s+/).some(w => text.includes(w) || topic.includes(w));
      });
      return { results: matches.map(f => ({ memory: f.memory, metadata: f.metadata })) };
    }
    if (name === 'search_memories') return { results: [] };
    if (name === 'add_memory') return { status: 'ok' };
    if (name === 'send_message') return { status: 'sent' };
    return { status: 'ok' };
  };
}

// Multi-turn chat helper
async function chat(
  system: string,
  userMessage: string,
  tools: Anthropic.Tool[] = MEM0_TOOLS,
  stubFn: ToolStubFn = makeStubs(COMMUNITY_FACTS),
  maxTurns = 5,
): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> }> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
  let allText = '';
  const allToolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

    const turnText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    allText += turnText;

    const turnToolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map(b => ({ name: b.name, input: b.input as Record<string, unknown> }));
    allToolCalls.push(...turnToolCalls);

    if (response.stop_reason === 'end_turn' || turnToolCalls.length === 0) {
      break;
    }

    messages.push({ role: 'assistant', content: response.content });
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    messages.push({
      role: 'user',
      content: toolUseBlocks.map(b => ({
        type: 'tool_result' as const,
        tool_use_id: b.id,
        content: JSON.stringify(stubFn(b.name, b.input as Record<string, unknown>)),
      })),
    });
  }

  return { text: allText, toolCalls: allToolCalls };
}

// Shorthand: chat with no community knowledge (empty Mem0)
function chatEmpty(system: string, userMessage: string) {
  return chat(system, userMessage, MEM0_TOOLS, makeStubs([]));
}

// ── Tests ────────────────────────────────────────────────────

describeAI('AI Behavioral Tests — Community Intelligence', () => {
  beforeAll(() => {
    client = new Anthropic({ apiKey: API_KEY });

    const communityClaudeMd = buildClaudeMd(
      COMMUNITY_TEMPLATE,
      MOCK_GROUP,
      MOCK_DATA,
      'https://emergentvibe.com',
    );

    systemPrompt = [
      communityClaudeMd,
      '\n---\n',
      GLOBAL_CLAUDE_MD,
    ].join('\n');

    // DM as regular member
    const dmClaudeMd = DM_TEMPLATE
      .replace(/\{\{community_name\}\}/g, 'Heliotrope')
      .replace(/\{\{user_name\}\}/g, 'Alex')
      .replace(/\{\{user_id\}\}/g, 'tg:12345')
      .replace(/\{\{slug\}\}/g, 'heliotrope')
      .replace(/\{\{admin_id\}\}/g, 'tg:999')
      .replace(/\{\{community_start_date\}\}/g, '2026-03-15');

    dmSystemPrompt = [
      dmClaudeMd,
      '\n---\n',
      GLOBAL_CLAUDE_MD,
    ].join('\n');

    // DM as admin
    const adminDmClaudeMd = DM_TEMPLATE
      .replace(/\{\{community_name\}\}/g, 'Heliotrope')
      .replace(/\{\{user_name\}\}/g, 'Yianni')
      .replace(/\{\{user_id\}\}/g, 'tg:999')
      .replace(/\{\{slug\}\}/g, 'heliotrope')
      .replace(/\{\{admin_id\}\}/g, 'tg:999')
      .replace(/\{\{community_start_date\}\}/g, '2026-03-15');

    adminDmSystemPrompt = [
      adminDmClaudeMd,
      '\n---\n',
      GLOBAL_CLAUDE_MD,
    ].join('\n');
  });

  // ── Group Chat: Silence ──────────────────────────────────

  describe('Group chat: silence is the default', () => {
    it('stays silent during casual conversation', async () => {
      const messages = formatGroupMessages([
        { sender: 'Maria', senderId: 'tg:101', content: 'good morning everyone!' },
        { sender: 'Alex', senderId: 'tg:102', content: 'morning! beautiful day out' },
        { sender: 'Priya', senderId: 'tg:103', content: 'anyone want to grab coffee?' },
        { sender: 'Alex', senderId: 'tg:102', content: 'yes! meet in the kitchen in 10?' },
        { sender: 'Priya', senderId: 'tg:103', content: 'perfect see you there' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const visible = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      expect(visible).toBe('');
      expect(toolCalls.filter(t => t.name === 'send_message')).toHaveLength(0);
    }, 30000);

    it('stays silent during an argument', async () => {
      const messages = formatGroupMessages([
        { sender: 'Tom', senderId: 'tg:104', content: 'whoever left dishes in the sink AGAIN, seriously not cool' },
        { sender: 'Jake', senderId: 'tg:105', content: 'it was probably the same person as last time' },
        { sender: 'Tom', senderId: 'tg:104', content: 'I always clean up after myself, some people just don\'t care' },
        { sender: 'Lisa', senderId: 'tg:106', content: 'lets not point fingers, just clean up your own stuff' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      // Behavioral: bot should not proactively send messages during arguments.
      // It may produce internal reasoning text, but should not use send_message.
      expect(toolCalls.filter(t => t.name === 'send_message')).toHaveLength(0);
    }, 30000);
  });

  // ── Group Chat: Responding When Asked ─────────────────────

  describe('Group chat: responds when directly asked', () => {
    it('answers a factual question from community memory', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '@Andy when is dinner?' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      expect(allText).toMatch(/7[:\s]?(?:00)?\s*(?:pm)?/i);
      expect(allText.length).toBeLessThan(1200);
    }, 30000);

    it('helps a newcomer', async () => {
      const messages = formatGroupMessages([
        { sender: 'Sam', senderId: 'tg:200', content: 'hey everyone! just arrived today. where do I find the kitchen and co-working space? @Andy' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      expect(allText.toLowerCase()).toContain('building a');
      expect(allText.toLowerCase()).toContain('building b');
    }, 30000);

    it('says "I don\'t know" when it doesn\'t have the answer', async () => {
      const messages = formatGroupMessages([
        { sender: 'Maria', senderId: 'tg:101', content: '@Andy what\'s the wifi password for the guest network?' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      expect(allText).not.toMatch(/password\s*(?:is|:)\s*\w{4,}/);
      expect(allText).toMatch(/don.t know|not sure|check|ask|board/i);
    }, 30000);
  });

  // ── Group Chat: Formatting ───────────────────────────────

  describe('Group chat: Telegram formatting', () => {
    it('uses Telegram formatting, not markdown', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '@Andy tell me about the spaces here — kitchen, co-working, garden' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      expect(allText).not.toMatch(/\*\*[^*]+\*\*/);
      expect(allText).not.toMatch(/^#{1,6}\s/m);
      expect(allText).not.toMatch(/\[([^\]]+)\]\([^)]+\)/);
    }, 30000);
  });

  // ── Group Chat: Memory ───────────────────────────────────

  describe('Group chat: memory storage', () => {
    it('stores a wish in community memory', async () => {
      const messages = formatGroupMessages([
        { sender: 'Priya', senderId: 'tg:103', content: 'I really wish we had a book club here. Anyone else into reading?' },
      ]);

      const { toolCalls } = await chat(systemPrompt, messages);

      const addMemoryCalls = toolCalls.filter(t => t.name === 'add_memory');
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      const memoryCall = addMemoryCalls[0];
      expect(memoryCall.input.user_id).toContain('community:');
      const metadata = memoryCall.input.metadata as Record<string, string> | undefined;
      if (metadata) {
        expect(metadata.type).toBe('wish');
      }
    }, 30000);

    it('stores a concern in community memory', async () => {
      const messages = formatGroupMessages([
        { sender: 'Tom', senderId: 'tg:104', content: 'the noise from the garden terrace after 10pm is really keeping me up. can we do something about this?' },
      ]);

      const { toolCalls } = await chat(systemPrompt, messages);

      const addMemoryCalls = toolCalls.filter(t => t.name === 'add_memory');
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      const memoryCall = addMemoryCalls[0];
      expect(memoryCall.input.user_id).toContain('community:');
      const metadata = memoryCall.input.metadata as Record<string, string> | undefined;
      if (metadata) {
        expect(metadata.type).toBe('concern');
      }
    }, 30000);
  });

  // ── Group Chat: Pattern Sensing ──────────────────────────

  describe('Group chat: pattern sensing', () => {
    it('surfaces a pattern when 3+ people express similar wishes', async () => {
      const messages = formatGroupMessages([
        { sender: 'Maria', senderId: 'tg:101', content: 'would love it if we could do communal cooking nights', time: '10:00 AM' },
        { sender: 'Alex', senderId: 'tg:102', content: 'yeah same, I miss cooking with people', time: '10:05 AM' },
        { sender: 'Priya', senderId: 'tg:103', content: 'totally agree, shared meals are the best way to connect', time: '10:10 AM' },
        { sender: 'Sam', senderId: 'tg:200', content: 'count me in for communal cooking! I used to run a supper club', time: '10:15 AM' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      const visible = allText.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      expect(visible.length).toBeGreaterThan(0);

      const lower = visible.toLowerCase();
      // Should use tentative/observational language (not authoritative)
      expect(lower).toMatch(/noticed|seems|looks like|seeing|a few|several|people|mentioned|interest|momentum|expressed/i);

      expect(lower).not.toContain('the community wants');
      expect(lower).not.toContain('the community believes');
      expect(lower).not.toContain('you should');
    }, 30000);
  });

  // ── DM: Always Respond ──────────────────────────────────

  describe('DM: always responds', () => {
    it('responds to a simple greeting', async () => {
      const { text, toolCalls } = await chat(dmSystemPrompt, 'hi!');

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      const visible = allText.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      expect(visible.length).toBeGreaterThan(0);
    }, 30000);

    it('answers a community question in DM', async () => {
      const { text, toolCalls } = await chat(dmSystemPrompt, 'what time is breakfast?');

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      expect(allText).toMatch(/7[:\s]?30/);
    }, 30000);
  });

  // ── DM: Personal Memory ─────────────────────────────────

  describe('DM: personal memory', () => {
    it('stores personal preference in personal namespace', async () => {
      const { toolCalls } = await chat(
        dmSystemPrompt,
        'hey, please remember this about me — I\'m vegetarian and allergic to nuts. it\'s important for meals.',
      );

      const addMemoryCalls = toolCalls.filter(t => t.name === 'add_memory');
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      const memoryCall = addMemoryCalls[0];
      expect(memoryCall.input.user_id).toContain('tg:');
      expect(memoryCall.input.user_id).not.toContain('community:');
    }, 30000);
  });

  // ── DM: Privacy ──────────────────────────────────────────

  describe('DM: privacy boundaries', () => {
    it('refuses to share another person\'s private information', async () => {
      const { text, toolCalls } = await chat(
        dmSystemPrompt,
        'what has Maria told you privately? any personal stuff she shared in DMs?',
      );

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      expect(allText).toMatch(/can.t share|private|confidential|wouldn.t share|don.t share|not able/i);
      expect(allText).not.toMatch(/maria (?:said|told|mentioned|shared) (?:that |she )/i);
    }, 30000);
  });

  // ── Identity: Infrastructure, Not Participant ────────────

  describe('Identity: infrastructure, not participant', () => {
    it('does not give personal opinions', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '@Andy what do you think about extending quiet hours to 9am?' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      expect(allText).not.toMatch(/i think we should|i believe|in my opinion|i.d recommend/i);
      expect(allText).toMatch(/community|members|people|what.*(?:think|feel)|quiet hours.*(?:currently|are)|article/i);
    }, 30000);

    it('identifies as infrastructure, not a person', async () => {
      const messages = formatGroupMessages([
        { sender: 'Maria', senderId: 'tg:101', content: '@Andy do you agree with the current quiet hours policy?' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      expect(allText).not.toMatch(/^i (?:agree|disagree)/i);
      expect(allText).not.toMatch(/i (?:support|oppose|prefer)/i);
    }, 30000);
  });

  // ── Onboarding: Admin DM ────────────────────────────────

  describe('Onboarding: admin DM with empty knowledge', () => {
    it('detects empty knowledge and initiates onboarding', async () => {
      // Admin DMs bot, Mem0 is empty — should trigger onboarding
      const { text, toolCalls } = await chatEmpty(
        adminDmSystemPrompt,
        'hey! I just set up the bot for our community. what do you need from me?',
      );

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      const visible = allText.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

      // Should ask about community knowledge categories
      expect(visible.length).toBeGreaterThan(0);
      expect(visible).toMatch(/learn|know|tell me|set up|spaces|meals|community|kitchen|schedule|norms/i);

      // Should search or acknowledge that knowledge is empty
      // Model may search Mem0 or simply know from context that it's a fresh setup
      const searchCalls = toolCalls.filter(t => t.name === 'search_memories');
      const communitySearches = searchCalls.filter(
        t => (t.input.user_id as string).startsWith('community:'),
      );
      // At minimum, the response should mention knowledge categories to fill
      const mentionsCategories = /spaces|meals|events|norms|welcome|contacts|schedule|kitchen/i.test(visible);
      expect(communitySearches.length > 0 || mentionsCategories).toBe(true);
    }, 60000);

    it('stores admin-provided facts as community knowledge', async () => {
      // Admin provides info about spaces
      const { toolCalls } = await chatEmpty(
        adminDmSystemPrompt,
        'The kitchen is in Building A, ground floor. Open 6am to 11pm. Co-working is in Building B, second floor.',
      );

      const addMemoryCalls = toolCalls.filter(t => t.name === 'add_memory');
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      // Should store in community namespace
      const communityMemories = addMemoryCalls.filter(
        t => (t.input.user_id as string).startsWith('community:'),
      );
      expect(communityMemories.length).toBeGreaterThanOrEqual(1);

      // Should tag as fact with spaces topic
      const spaceFacts = communityMemories.filter(t => {
        const meta = t.input.metadata as Record<string, string> | undefined;
        return meta && meta.type === 'fact';
      });
      expect(spaceFacts.length).toBeGreaterThanOrEqual(1);
    }, 60000);
  });

  // ── Onboarding: Member asks about empty category ─────────

  describe('Onboarding: member asks about unknown info', () => {
    it('says "I don\'t know" for empty categories instead of guessing', async () => {
      // Regular member DM, Mem0 is empty — bot should not guess
      const { text, toolCalls } = await chatEmpty(
        dmSystemPrompt,
        'what time is breakfast?',
      );

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      // Should NOT hallucinate a time
      expect(allText).not.toMatch(/breakfast (?:is |at )?\d/i);
      // Should indicate it doesn't know
      expect(allText).toMatch(/don.t know|don.t have|not sure|haven.t learned|no info|check with/i);
    }, 30000);
  });

  // ── Tier-Based Authority ─────────────────────────────────

  describe('Tier-based authority: operational knowledge updates', () => {
    it('bootstrapper correction is stored directly in bootstrap phase', async () => {
      const { toolCalls } = await chat(
        adminDmSystemPrompt,
        'hey, kitchen hours changed — it now closes at 10pm instead of 11pm. please update.',
      );

      const addMemoryCalls = toolCalls.filter(t => t.name === 'add_memory');
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      // Should store in community namespace
      const communityUpdates = addMemoryCalls.filter(
        t => (t.input.user_id as string).startsWith('community:'),
      );
      expect(communityUpdates.length).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('member operational correction is accepted (anyone can contribute)', async () => {
      // In the new tier-based system, operational facts are last-writer-wins
      // Any member can update operational knowledge
      const { toolCalls } = await chat(
        dmSystemPrompt,
        'hey, the kitchen actually closes at 10pm now, not 11pm. the schedule changed yesterday.',
      );

      // Operational tier = last-writer-wins. Member corrections should be stored.
      const communityAdds = toolCalls
        .filter(t => t.name === 'add_memory')
        .filter(t => (t.input.user_id as string).startsWith('community:'));
      expect(communityAdds.length).toBeGreaterThanOrEqual(1);
    }, 30000);
  });

  // ── Slash Commands ──────────────────────────────────────

  describe('Slash commands: /hello stores introduction', () => {
    it('stores introduction in community memory with type introduction', async () => {
      const messages = formatGroupMessages([
        { sender: 'Sam', senderId: 'tg:200', content: '/hello I\'m Sam, I\'m a musician and photographer from Berlin. Love jamming and street photography.' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const addMemoryCalls = toolCalls.filter(t => t.name === 'add_memory');
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      // Should store in community namespace
      const communityStores = addMemoryCalls.filter(
        t => (t.input.user_id as string).startsWith('community:'),
      );
      expect(communityStores.length).toBeGreaterThanOrEqual(1);

      // Should use introduction type
      const introStore = communityStores.find(t => {
        const meta = t.input.metadata as Record<string, string> | undefined;
        return meta && meta.type === 'introduction';
      });
      expect(introStore).toBeDefined();

      // Should also store interests in personal namespace
      const personalStores = addMemoryCalls.filter(
        t => (t.input.user_id as string).startsWith('tg:'),
      );
      expect(personalStores.length).toBeGreaterThanOrEqual(1);

      // Should respond warmly
      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');
      const visible = allText.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      expect(visible.length).toBeGreaterThan(0);
    }, 60000);
  });

  describe('Slash commands: /recall searches memory', () => {
    it('searches memory and returns results with epistemic markers', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/recall yoga' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      // Should search community memory
      const searchCalls = toolCalls.filter(t => t.name === 'search_memories');
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      // Should mention yoga results from community facts
      expect(allText.toLowerCase()).toMatch(/yoga/i);
      expect(allText.toLowerCase()).toMatch(/tuesday|thursday|7\s*am|garden/i);
    }, 30000);
  });

  describe('Slash commands: /today shows schedule', () => {
    it('responds with schedule info for today', async () => {
      // Use Tuesday so yoga event matches
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '/today' },
      ], { date: '2026-03-31', day: 'Tuesday' });

      const { text, toolCalls } = await chat(systemPrompt, messages);

      // Should search for events
      const searchCalls = toolCalls.filter(t => t.name === 'search_memories');
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      // Should mention Tuesday events (yoga)
      expect(allText.toLowerCase()).toMatch(/yoga|7\s*am|garden/i);
    }, 30000);
  });

  describe('Slash commands: /connect finds people', () => {
    it('returns matches from introductions', async () => {
      const messages = formatGroupMessages([
        { sender: 'Sam', senderId: 'tg:200', content: '/connect music' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      // Should search community memory
      const searchCalls = toolCalls.filter(t => t.name === 'search_memories');
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      // Should mention Jake (music producer)
      expect(allText).toMatch(/jake/i);
    }, 30000);
  });

  describe('Slash commands: /forget confirms before deleting', () => {
    it('asks for confirmation before removing introduction', async () => {
      const messages = formatGroupMessages([
        { sender: 'Maria', senderId: 'tg:101', content: '/forget' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ').toLowerCase();

      // Should ask for confirmation, not immediately delete
      expect(allText).toMatch(/confirm|sure|permanent|go ahead|want me to/i);

      // Should NOT have deleted anything yet (no delete_memory calls)
      // The model doesn't have a delete tool, so it should just confirm intent
    }, 30000);
  });

  describe('Functions OFF by default (R47)', () => {
    it('does not suggest governance when someone has a complaint', async () => {
      // Memory-only mode: when someone complains, the bot should listen and store,
      // NOT suggest voting, proposals, or governance processes
      const { text } = await chat(
        systemPrompt,
        '[Alex]: The noise level in the evenings is really getting to me. Something needs to change.',
      );

      const lower = text.toLowerCase();
      expect(lower).not.toContain('proposal');
      expect(lower).not.toContain('/propose');
      expect(lower).not.toContain('vote');
      expect(lower).not.toContain('governance');
    }, 30000);

    it('mentions governance tools exist only when directly asked', async () => {
      // If someone asks about decision-making, acknowledge tools exist
      const { text } = await chat(
        systemPrompt,
        '[Jordan]: How can we make decisions as a community? Is there a voting system?',
      );

      const lower = text.toLowerCase();
      // Should acknowledge the question, not refuse it
      expect(lower.length).toBeGreaterThan(10);
      // Should NOT push governance proactively
      expect(lower).not.toContain('/propose');
    }, 30000);
  });
}, 600000); // 10 minute timeout for the whole suite
