/**
 * Extraction quality tests — calls real Haiku to verify the extraction prompt
 * produces correct memories from various message patterns.
 *
 * Skipped when ANTHROPIC_API_KEY is not set. Cost: ~$0.02 per full run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { extractMemories, _setClient } from './extraction.js';
import type { NewMessage } from './types.js';

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

function msg(sender: string, content: string, minutesAgo = 0): NewMessage {
  const ts = new Date(Date.now() - minutesAgo * 60_000);
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    chat_jid: 'tg:test-group',
    sender: `tg:${sender.toLowerCase()}`,
    sender_name: sender,
    content,
    timestamp: ts.toISOString(),
    is_from_me: false,
  };
}

describe.skipIf(!HAS_API_KEY)('extraction quality (real Haiku)', () => {
  afterAll(() => _setClient(null));

  it('extracts operational facts', async () => {
    const result = await extractMemories(
      [
        msg(
          'Jordan',
          'Kitchen is open 7am to 10pm, ground floor of the main house.',
        ),
        msg('Jordan', 'Yoga is every morning at 7:30 on the meadow.'),
        msg('Jordan', "Wifi network is 'treeweek' password 'oak2026'."),
      ],
      [],
      'eq-test',
      'Treeweek III',
    );

    expect(result.memories.length).toBeGreaterThanOrEqual(3);
    const texts = result.memories.map((m) => m.text.toLowerCase()).join(' ');
    expect(texts).toContain('kitchen');
    expect(texts).toContain('yoga');
    expect(texts).toMatch(/wifi|oak2026|treeweek/);

    for (const mem of result.memories) {
      expect(mem.user_id).toBe('community:eq-test');
      expect(mem.metadata?.type).toBe('fact');
      expect(mem.metadata?.tier).toBe('operational');
    }
  }, 30_000);

  it('extracts introductions', async () => {
    const result = await extractMemories(
      [
        msg(
          'Alex',
          "/hello I'm Alex, a designer from Portland. Into ceramics and hiking.",
        ),
        msg(
          'Sam',
          "/hello Hey! I'm Sam, musician and photographer from Berlin.",
        ),
      ],
      [],
      'eq-test',
      'Treeweek III',
    );

    expect(result.memories.length).toBeGreaterThanOrEqual(2);
    const texts = result.memories.map((m) => m.text.toLowerCase()).join(' ');
    expect(texts).toContain('alex');
    expect(texts).toContain('sam');
    expect(texts).toMatch(/ceramics|design/);
    expect(texts).toMatch(/musician|photographer/);

    const intros = result.memories.filter(
      (m) => m.metadata?.type === 'introduction',
    );
    expect(intros.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('extracts wishes and concerns', async () => {
    const result = await extractMemories(
      [
        msg('Priya', 'I really wish we could do morning swimming in the lake.'),
        msg(
          'River',
          'The noise after midnight in the garden is making it hard to sleep.',
        ),
      ],
      [],
      'eq-test',
      'Treeweek III',
    );

    expect(result.memories.length).toBeGreaterThanOrEqual(2);
    const types = result.memories.map((m) => m.metadata?.type);
    expect(types).toContain('wish');
    expect(types).toContain('concern');

    const texts = result.memories.map((m) => m.text.toLowerCase()).join(' ');
    expect(texts).toContain('priya');
    expect(texts).toContain('river');
    expect(texts).toMatch(/swim/);
    expect(texts).toMatch(/noise/);
  }, 30_000);

  it('rejects banter and noise', async () => {
    const result = await extractMemories(
      [
        msg('Alex', 'haha nice one 😂'),
        msg('Sam', 'morning everyone!'),
        msg('Priya', 'lol who left the dishes in the sink'),
        msg('River', '👍'),
        msg('Casey', 'anyone want coffee?'),
      ],
      [],
      'eq-test',
      'Treeweek III',
    );

    expect(result.memories.length).toBe(0);
  }, 30_000);

  it('extracts operational change with history', async () => {
    const result = await extractMemories(
      [
        msg(
          'Jordan',
          'Update: dinner is moved from 7pm to 6:30pm tonight because of kitchen prep.',
        ),
      ],
      [msg('Jordan', 'Dinner at 7pm in the main house kitchen.', 120)],
      'eq-test',
      'Treeweek III',
    );

    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const text = result.memories[0].text.toLowerCase();
    expect(text).toMatch(/6:30|6\.30|6:30pm/);
    expect(text).toMatch(/7pm|7:00|moved|changed/);
    expect(result.memories[0].metadata?.type).toBe('fact');
  }, 30_000);

  it('detects pattern from multiple similar wishes', async () => {
    const result = await extractMemories(
      [
        msg('Alex', 'Would love to do morning lake swims.'),
        msg('Priya', 'Anyone else interested in swimming in the mornings?'),
        msg('River', 'A morning swim would be amazing, count me in.'),
      ],
      [],
      'eq-test',
      'Treeweek III',
    );

    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text.toLowerCase()).join(' ');
    expect(texts).toMatch(/swim/);
    // Should detect the pattern — multiple people want the same thing
    const patterns = result.memories.filter(
      (m) => m.metadata?.type === 'pattern',
    );
    const wishes = result.memories.filter((m) => m.metadata?.type === 'wish');
    expect(patterns.length + wishes.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('does not re-extract from context messages', async () => {
    const result = await extractMemories(
      [msg('Sam', 'Thanks for letting us know about the schedule change!')],
      [msg('Jordan', 'Yoga moved from 7:30 to 8am starting tomorrow.', 30)],
      'eq-test',
      'Treeweek III',
    );

    // The yoga change is in CONTEXT (already extracted), not new messages.
    // The new message is just a reaction — should extract nothing.
    expect(result.memories.length).toBe(0);
  }, 30_000);
});
