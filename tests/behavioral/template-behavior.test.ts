/**
 * Lightweight behavioral tests — sends the rendered template as system prompt
 * to Sonnet with mock tool definitions, verifies the agent's behavior without
 * needing Docker, Mem0, or the full sim infrastructure.
 *
 * Requires ANTHROPIC_API_KEY. Cost: ~$0.20 per run (4 Sonnet calls).
 */
import { describe, it, expect, afterAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import {
  stripDisabledFeatures,
  type FeatureConfig,
} from '../../src/feature-config.js';

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

const TEMPLATES_DIR = path.resolve(
  import.meta.dirname ?? '.',
  '../../governance/templates',
);

function buildTestClaudeMd(features?: Partial<FeatureConfig>): string {
  const base = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'base-template.md'),
    'utf-8',
  );
  const group = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'group-template.md'),
    'utf-8',
  );
  let template = base + '\n\n' + group;

  const fullFeatures: FeatureConfig = {
    commands: {
      purchase: true,
      subscribe: true,
      rota: true,
      ...features?.commands,
    },
    behaviors: {
      daily_digest: true,
      crew_digest: true,
      ...features?.behaviors,
    },
  };
  template = stripDisabledFeatures(template, fullFeatures);

  return template
    .replace(/\{\{community_name\}\}/g, 'Treeweek III')
    .replace(/\{\{slug\}\}/g, 'treeweek')
    .replace(/\{\{assistant_name\}\}/g, 'treeweek_bot')
    .replace(/\{\{crew_list\}\}/g, 'Jordan, Alex')
    .replace(/\{\{admin_name\}\}/g, 'Jordan')
    .replace(/\{\{community_start_date\}\}/g, '2026-09-22')
    .replace(/\{\{[a-z_]+\}\}/g, '(Not configured)');
}

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'add_memory',
    description: 'Store a memory in community namespace',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string' },
        user_id: { type: 'string' },
        metadata: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            topic: { type: 'string' },
            tier: { type: 'string' },
            source: { type: 'string' },
            source_context: { type: 'string' },
          },
        },
      },
      required: ['text', 'user_id'],
    },
  },
  {
    name: 'search_memories',
    description: 'Search community memory',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        user_id: { type: 'string' },
      },
      required: ['query', 'user_id'],
    },
  },
];

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

async function askAgent(
  systemPrompt: string,
  userMessage: string,
): Promise<{ text: string; toolCalls: Anthropic.Messages.ToolUseBlock[] }> {
  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: systemPrompt,
    tools: TOOLS,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const toolCalls = response.content.filter(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
  );

  return { text, toolCalls };
}

describe.skipIf(!HAS_API_KEY)(
  'template behavioral tests (real Sonnet)',
  () => {
    afterAll(() => {
      client = null;
    });

    const claudeMd = buildTestClaudeMd();

    it('does not store facts during conversation — only searches', async () => {
      const { toolCalls } = await askAgent(
        claudeMd,
        '[Jordan]: Dinner is at 7pm in the main house tonight.\n\n[Alex]: @treeweek_bot what time is dinner?',
      );

      const addMemoryCalls = toolCalls.filter(
        (t) => t.name === 'add_memory',
      );
      const searchCalls = toolCalls.filter(
        (t) => t.name === 'search_memories',
      );

      expect(addMemoryCalls.length).toBe(0);
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);
    }, 30_000);

    it('redirects rota questions to commands', async () => {
      const { text } = await askAgent(
        claudeMd,
        '[Sam]: @treeweek_bot when is my kitchen shift?',
      );

      const lower = text.toLowerCase();
      expect(lower).toMatch(/\/myrota|\/shiftstoday|\/shiftsopen/);
      expect(lower).not.toMatch(
        /your shift is|you're on|you are scheduled/,
      );
    }, 30_000);

    it('describes itself as event tracker, not knowledge extractor', async () => {
      const { text } = await askAgent(
        claudeMd,
        '[Priya]: @treeweek_bot how do you work? what do you do with our messages?',
      );

      const lower = text.toLowerCase();
      expect(lower).toMatch(/event|schedule|what's on/);
      expect(lower).not.toMatch(
        /extract community knowledge|extract knowledge from everything/,
      );
    }, 30_000);

    it('uses add_memory for /hello introductions', async () => {
      const { toolCalls } = await askAgent(
        claudeMd,
        "[River]: /hello I'm River, a sound artist from Amsterdam. Into field recordings and synthesis.",
      );

      const addMemoryCalls = toolCalls.filter(
        (t) => t.name === 'add_memory',
      );
      expect(addMemoryCalls.length).toBeGreaterThanOrEqual(1);

      const memText = JSON.stringify(
        addMemoryCalls[0].input,
      ).toLowerCase();
      expect(memText).toMatch(/river/);
      expect(memText).toMatch(/sound|artist|field recording|synthesis/);
    }, 30_000);
  },
);
