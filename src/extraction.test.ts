import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  extractMemories,
  buildExtractionPrompt,
  _setClient,
} from './extraction.js';
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

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const promptContent = createCall.messages[0].content;
    expect(promptContent).toContain('CONTEXT');
    expect(promptContent).toContain('Context from earlier');
    expect(promptContent).toContain('Fresh message');
  });
});

describe('Extraction prompt: absolute dates', () => {
  it('includes current date in the prompt', () => {
    const prompt = buildExtractionPrompt(
      'Test Group',
      'test-slug',
      [],
      [makeMessage('Alice', 'Dinner moved to 6pm')],
    );
    expect(prompt).toMatch(/Current date and time: \w+, \d+ \w+ \d{4}/);
  });

  it('instructs never to use relative dates', () => {
    const prompt = buildExtractionPrompt(
      'Test Group',
      'test-slug',
      [],
      [makeMessage('Alice', 'Dinner moved to 6pm')],
    );
    expect(prompt).toContain('Always use absolute dates');
    expect(prompt).toContain('never relative dates');
    expect(prompt).toContain('"today"');
    expect(prompt).toContain('"tonight"');
    expect(prompt).toContain('"tomorrow"');
  });

  it('uses absolute dates in example extractions', () => {
    const prompt = buildExtractionPrompt(
      'Test Group',
      'test-slug',
      [],
      [makeMessage('Alice', 'Workshop at 3pm')],
    );
    expect(prompt).toContain('Thu 25 Sep');
    expect(prompt).not.toContain('"Workshop at 3pm in the garden today');
  });
});

describe('Extraction prompt: 24-hour time disambiguation', () => {
  it('instructs to use 24-hour format', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'workshop at 9')],
    );
    expect(prompt).toContain('24-hour times');
    expect(prompt).toContain('"21:00" not "9pm"');
  });

  it('tells Haiku to use message timestamps for disambiguation', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'workshop at 9')],
    );
    expect(prompt).toContain(
      'Each message below has a 24-hour timestamp in brackets',
    );
  });

  it('limits same-day inference to same-day events only', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'workshop at 9')],
    );
    expect(prompt).toContain('ONLY for same-day events');
  });

  it('defaults future-date bare times to morning', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'tomorrow at 9')],
    );
    expect(prompt).toContain(
      '"tomorrow at 9" or any future date with a bare time defaults to morning (09:00)',
    );
  });

  it('overrides future-date morning default with evening context', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'tomorrow evening at 9')],
    );
    expect(prompt).toContain('"tomorrow evening at 9" = 21:00');
  });

  it('handles tonight/this evening as after 17:00', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'jam session tonight')],
    );
    expect(prompt).toContain(
      '"tonight" or "this evening" event is always after 17:00',
    );
  });

  it('includes fallback for truly ambiguous times', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'something at 9')],
    );
    expect(prompt).toContain('include both possibilities');
  });

  it('provides social event heuristic for bare times', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'workshop at 9')],
    );
    expect(prompt).toContain('workshops, jam sessions, movie nights');
    expect(prompt).toContain('almost always evening (21:00)');
  });

  it('uses 24-hour format in example extractions', () => {
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'workshop')],
    );
    expect(prompt).toContain('Workshop at 15:00');
    expect(prompt).toContain('19:00 to 18:30');
    expect(prompt).toContain('at 20:00');
    expect(prompt).not.toContain('at 3pm');
    expect(prompt).not.toContain('from 7pm');
  });

  it('formats message timestamps in 24-hour for Haiku context', () => {
    const eveningTs = '2026-09-23T20:15:00.000Z';
    const prompt = buildExtractionPrompt(
      'Test',
      'test',
      [],
      [makeMessage('Alice', 'workshop at 9', eveningTs)],
    );
    expect(prompt).toMatch(/\[2[0-2]:\d{2} Alice\]/);
  });
});

// Real Haiku AM/PM accuracy tests are in extraction-quality.test.ts
