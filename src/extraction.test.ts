import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { extractMemories, _setClient } from './extraction.js';
import type { NewMessage } from './types.js';

function makeMessage(
  sender: string,
  content: string,
  timestamp?: string,
): NewMessage {
  return {
    id: `msg-${Math.random()}`,
    chat_jid: 'tg:group1',
    sender: `tg:${sender}`,
    sender_name: sender,
    content,
    timestamp: timestamp || new Date().toISOString(),
    is_from_me: false,
  };
}

function mockClient(responseText: string): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  } as unknown as Anthropic;
}

describe('extractMemories', () => {
  afterEach(() => {
    _setClient(null);
  });

  it('returns empty for no messages', async () => {
    const result = await extractMemories([], [], 'test-slug', 'Test Group');
    expect(result.memories).toEqual([]);
  });

  it('parses valid extraction response', async () => {
    const response = JSON.stringify([
      {
        text: 'The sauna is heated daily from 4pm to 10pm',
        user_id: 'community:test-slug',
        metadata: {
          type: 'fact',
          topic: 'sauna',
          tier: 'operational',
          source: 'Jordan',
          source_context: 'group',
        },
      },
    ]);
    _setClient(mockClient(response));

    const result = await extractMemories(
      [makeMessage('Jordan', 'Sauna is heated 4pm to 10pm daily.')],
      [],
      'test-slug',
      'Test Group',
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].text).toContain('sauna');
    expect(result.memories[0].user_id).toBe('community:test-slug');
    expect(result.memories[0].metadata?.tier).toBe('operational');
  });

  it('handles empty array response', async () => {
    _setClient(mockClient('[]'));

    const result = await extractMemories(
      [makeMessage('Alex', 'lol nice')],
      [],
      'test-slug',
      'Test Group',
    );

    expect(result.memories).toEqual([]);
  });

  it('handles response with markdown wrapping', async () => {
    const response = `Here are the extracted memories:\n\n\`\`\`json\n[{"text": "Wifi password is coral2026", "user_id": "community:test-slug", "metadata": {"type": "fact"}}]\n\`\`\``;
    _setClient(mockClient(response));

    const result = await extractMemories(
      [makeMessage('Jordan', 'Wifi is coral2026')],
      [],
      'test-slug',
      'Test Group',
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].text).toContain('coral2026');
  });

  it('handles API error gracefully', async () => {
    _setClient({
      messages: {
        create: vi.fn().mockRejectedValue(new Error('API error')),
      },
    } as unknown as Anthropic);

    const result = await extractMemories(
      [makeMessage('Alex', 'Some message')],
      [],
      'test-slug',
      'Test Group',
    );

    expect(result.memories).toEqual([]);
  });

  it('handles malformed JSON gracefully', async () => {
    _setClient(mockClient('not valid json at all'));

    const result = await extractMemories(
      [makeMessage('Alex', 'Some message')],
      [],
      'test-slug',
      'Test Group',
    );

    expect(result.memories).toEqual([]);
  });

  it('extracts multiple memories from one batch', async () => {
    const response = JSON.stringify([
      {
        text: 'Dinner at 7pm in the main house',
        user_id: 'community:test-slug',
        metadata: { type: 'fact', tier: 'operational', source: 'Jordan' },
      },
      {
        text: 'Alex introduced themselves as a painter from Amsterdam',
        user_id: 'community:test-slug',
        metadata: { type: 'introduction', tier: 'social', source: 'Alex' },
      },
    ]);
    _setClient(mockClient(response));

    const result = await extractMemories(
      [
        makeMessage('Jordan', 'Dinner at 7pm in the main house.'),
        makeMessage(
          'Alex',
          '/hello I am Alex, painter from Amsterdam, love swimming.',
        ),
      ],
      [],
      'test-slug',
      'Test Group',
    );

    expect(result.memories).toHaveLength(2);
    expect(result.memories[0].metadata?.type).toBe('fact');
    expect(result.memories[1].metadata?.type).toBe('introduction');
  });

  it('passes context messages to the prompt', async () => {
    const client = mockClient('[]');
    _setClient(client);

    const contextMsgs = [makeMessage('Old', 'Context from earlier')];
    const newMsgs = [makeMessage('New', 'Fresh message')];

    await extractMemories(newMsgs, contextMsgs, 'test-slug', 'Test Group');

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    const promptContent = createCall.messages[0].content;
    expect(promptContent).toContain('CONTEXT');
    expect(promptContent).toContain('Context from earlier');
    expect(promptContent).toContain('Fresh message');
  });
});
