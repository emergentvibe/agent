/**
 * AI Behavioral Tests — Community Intelligence
 *
 * Tests real AI responses using the Anthropic API.
 * Verifies the bot behaves correctly given community CLAUDE.md context:
 * silence in groups, responding when asked, Telegram formatting,
 * memory tool usage, pattern sensing, privacy, identity.
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
import { describe, it, expect, beforeAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { buildClaudeMd, type ConstitutionData } from '../../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../../governance/sync/config.js';

// ── Skip if no API key ───────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY;
const describeAI = API_KEY ? describe : describe.skip;

// ── Setup ────────────────────────────────────────────────────

let client: Anthropic;
let systemPrompt: string;
let dmSystemPrompt: string;

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
            type: { type: 'string', enum: ['wish', 'concern', 'fact', 'connection', 'preference'] },
            topic: { type: 'string' },
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

// Load community-knowledge files
const KNOWLEDGE_DIR = path.resolve(TEST_DIR, 'community-knowledge');
const knowledgeFiles = fs.readdirSync(KNOWLEDGE_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => `## ${f.replace('.md', '')}\n${fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf-8')}`)
  .join('\n\n');

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
};

const MOCK_DATA: ConstitutionData = {
  slug: 'heliotrope',
  name: 'Heliotrope Constitution',
  content: CONSTITUTION,
  version: '1.0.0',
  content_hash: 'test123',
  updated_at: '2026-03-15T12:00:00Z',
};

// Format messages like NanoClaw does (XML format from router.ts)
function formatGroupMessages(messages: Array<{ sender: string; senderId: string; content: string; time?: string }>): string {
  const lines = messages.map(m => {
    const time = m.time || '10:00 AM';
    return `<message sender="${m.sender}" sender_id="${m.senderId}" time="${time}">${m.content}</message>`;
  });
  return `<context timezone="Europe/Athens" />\n<messages>\n${lines.join('\n')}\n</messages>`;
}

// Helper: call Claude and get back text + tool calls
async function chat(
  system: string,
  userMessage: string,
  tools: Anthropic.Tool[] = MEM0_TOOLS,
): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> }> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system,
    tools,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map(b => ({ name: b.name, input: b.input as Record<string, unknown> }));

  return { text, toolCalls };
}

// ── Tests ────────────────────────────────────────────────────

describeAI('AI Behavioral Tests — Community Intelligence', () => {
  beforeAll(() => {
    client = new Anthropic({ apiKey: API_KEY });

    // Build community CLAUDE.md
    const communityClaudeMd = buildClaudeMd(
      COMMUNITY_TEMPLATE,
      MOCK_GROUP,
      MOCK_DATA,
      'https://emergentvibe.com',
    );

    // Compose group system prompt: global (appended) + community (cwd CLAUDE.md)
    // In the real system, global is appended via systemPrompt.append and community
    // is loaded from cwd. Here we combine them.
    systemPrompt = [
      communityClaudeMd,
      '\n---\n',
      '## Community Knowledge Files\n',
      knowledgeFiles,
      '\n---\n',
      GLOBAL_CLAUDE_MD,
    ].join('\n');

    // Build DM system prompt
    const dmClaudeMd = DM_TEMPLATE
      .replace(/\{\{community_name\}\}/g, 'Heliotrope')
      .replace(/\{\{user_name\}\}/g, 'Alex')
      .replace(/\{\{user_id\}\}/g, 'tg:12345')
      .replace(/\{\{slug\}\}/g, 'heliotrope');

    dmSystemPrompt = [
      dmClaudeMd,
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

      // Bot should produce empty or internal-only output
      const visible = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      expect(visible).toBe('');
      // Should not call send_message either
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

      const visible = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      expect(visible).toBe('');
      expect(toolCalls.filter(t => t.name === 'send_message')).toHaveLength(0);
    }, 30000);
  });

  // ── Group Chat: Responding When Asked ─────────────────────

  describe('Group chat: responds when directly asked', () => {
    it('answers a factual question from community knowledge', async () => {
      const messages = formatGroupMessages([
        { sender: 'Alex', senderId: 'tg:102', content: '@Andy when is dinner?' },
      ]);

      const { text, toolCalls } = await chat(systemPrompt, messages);

      const allText = [
        text,
        ...toolCalls.filter(t => t.name === 'send_message').map(t => t.input.text as string),
      ].join(' ');

      // Should mention dinner time
      expect(allText).toMatch(/7[:\s]?(?:00)?\s*(?:pm)?/i);
      // Should be brief, not a wall of text
      expect(allText.length).toBeLessThan(500);
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

      // Should mention both locations
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

      // Should not make up a password
      expect(allText).not.toMatch(/password\s*(?:is|:)\s*\w{4,}/);
      // Should indicate uncertainty or not knowing
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

      // Should NOT use markdown
      expect(allText).not.toMatch(/\*\*[^*]+\*\*/); // no **bold**
      expect(allText).not.toMatch(/^#{1,6}\s/m); // no ## headings
      expect(allText).not.toMatch(/\[([^\]]+)\]\([^)]+\)/); // no [text](url)
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
      // Should use community namespace
      expect(memoryCall.input.user_id).toContain('community:');
      // Should tag as wish
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

      // Should surface the pattern
      const visible = allText.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      expect(visible.length).toBeGreaterThan(0); // Should actually say something

      // Should use tentative language
      const lower = visible.toLowerCase();
      expect(lower).toMatch(/noticed|seems|looks like|a few|several|people|mentioned|interest/i);

      // Should NOT use authoritative language
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
        'hey, just so you know — I\'m vegetarian and allergic to nuts',
      );

      const addMemoryCalls = toolCalls.filter(t => t.name === 'add_memory');
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      const memoryCall = addMemoryCalls[0];
      // Should use personal namespace (tg:), NOT community namespace
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

      // Should refuse or deflect
      expect(allText).toMatch(/can.t share|private|confidential|wouldn.t share|don.t share|not able/i);
      // Should NOT make up information about Maria
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

      // Should NOT express a personal opinion
      expect(allText).not.toMatch(/i think we should|i believe|in my opinion|i.d recommend/i);
      // Should redirect to community or provide neutral info
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

      // Should not say "I agree" or "I disagree"
      expect(allText).not.toMatch(/^i (?:agree|disagree)/i);
      // Should not take a side
      expect(allText).not.toMatch(/i (?:support|oppose|prefer)/i);
    }, 30000);
  });
}, 300000); // 5 minute timeout for the whole suite
