import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ANTHROPIC_API_KEY: 'test-key' })),
}));

import { triageMessages, _setClient } from './triage.js';
import type { NewMessage } from './types.js';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: 'user1',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-03-30T12:00:00Z',
    ...overrides,
  };
}

function mockClient(responseText: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

describe('triageMessages', () => {
  beforeEach(() => {
    _setClient(null);
  });

  it('returns respond=true for direct questions', async () => {
    const client = mockClient(
      JSON.stringify({
        respond: true,
        memories: [],
        reason: 'direct question about schedule',
      }),
    );
    _setClient(client);

    const result = await triageMessages(
      [makeMessage({ content: 'What time is dinner?' })],
      'edge-esmeralda',
      'Edge Main',
      'Andy',
    );

    expect(result.respond).toBe(true);
    expect(result.reason).toContain('schedule');
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it('returns respond=false for banter', async () => {
    const client = mockClient(
      JSON.stringify({
        respond: false,
        memories: [],
        reason: 'casual banter',
      }),
    );
    _setClient(client);

    const result = await triageMessages(
      [
        makeMessage({ content: 'lol that was hilarious' }),
        makeMessage({ content: 'ikr 😂', sender: 'user2', sender_name: 'Bob' }),
      ],
      'edge-esmeralda',
      'Edge Main',
      'Andy',
    );

    expect(result.respond).toBe(false);
  });

  it('extracts memories from personal declarations into community namespace', async () => {
    const client = mockClient(
      JSON.stringify({
        respond: false,
        memories: [
          {
            text: 'Alice is vegan',
            user_id: 'community:edge-esmeralda',
          },
        ],
        reason: 'personal declaration, no response needed',
      }),
    );
    _setClient(client);

    const result = await triageMessages(
      [makeMessage({ content: "I'm vegan btw" })],
      'edge-esmeralda',
      'Edge Main',
      'Andy',
    );

    expect(result.respond).toBe(false);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].text).toBe('Alice is vegan');
    expect(result.memories[0].user_id).toBe('community:edge-esmeralda');
  });

  it('falls back to respond=true on invalid JSON', async () => {
    const client = mockClient('not valid json');
    _setClient(client);

    const result = await triageMessages(
      [makeMessage({ content: 'Hello bot' })],
      'edge-esmeralda',
      'Edge Main',
      'Andy',
    );

    expect(result.respond).toBe(true);
    expect(result.reason).toContain('triage error');
  });

  it('falls back to respond=true on invalid shape', async () => {
    const client = mockClient(JSON.stringify({ foo: 'bar' }));
    _setClient(client);

    const result = await triageMessages(
      [makeMessage({ content: 'test' })],
      'edge-esmeralda',
      'Edge Main',
      'Andy',
    );

    expect(result.respond).toBe(true);
  });

  it('falls back to respond=true on API error', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('rate limited')),
      },
    } as unknown as import('@anthropic-ai/sdk').default;
    _setClient(client);

    const result = await triageMessages(
      [makeMessage({ content: 'test' })],
      'edge-esmeralda',
      'Edge Main',
      'Andy',
    );

    expect(result.respond).toBe(true);
    expect(result.reason).toContain('triage error');
  });

  it('includes sender names in message formatting', async () => {
    const client = mockClient(
      JSON.stringify({ respond: true, memories: [], reason: 'test' }),
    );
    _setClient(client);

    await triageMessages(
      [
        makeMessage({ content: 'Hey!', sender_name: 'Alice' }),
        makeMessage({ content: 'Hi!', sender: 'user2', sender_name: 'Bob' }),
      ],
      'edge-esmeralda',
      'Edge Main',
      'Andy',
    );

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.messages[0].content).toContain('[Alice]');
    expect(call.messages[0].content).toContain('[Bob]');
  });
});
