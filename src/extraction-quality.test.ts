/**
 * Extraction quality tests — calls real Haiku to verify the extraction prompt
 * produces correct memories from various message patterns.
 *
 * Reads ANTHROPIC_API_KEY from .env if not in environment.
 * Cost: ~$0.04 per full run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { extractMemories, _setClient } from './extraction.js';
import type { NewMessage } from './types.js';

dotenv.config();
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

  it('does not extract introductions (handled by /hello)', async () => {
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

    expect(result.memories.length).toBe(0);
  }, 30_000);

  it('extracts activity proposals and facility concerns', async () => {
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

    expect(result.memories.length).toBeGreaterThanOrEqual(1);

    const texts = result.memories.map((m) => m.text.toLowerCase()).join(' ');
    expect(texts).toMatch(/swim|noise/);
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
    expect(text).toMatch(/18:30|6:30|6\.30/);
    expect(text).toMatch(/19:00|7pm|7:00|moved|changed/);
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

function msgAt(sender: string, content: string, hour: number, minute = 0): NewMessage {
  const ts = new Date();
  ts.setHours(hour, minute, 0, 0);
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

describe.skipIf(!HAS_API_KEY)('extraction: time disambiguation (real Haiku)', () => {
  afterAll(() => _setClient(null));

  it('evening post about "at 9" → 21:00 (the Meisner bug)', async () => {
    const result = await extractMemories(
      [msgAt('Val', 'Meisner workshop at 9', 12, 55)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/21:00|21\.00/);
    expect(texts).not.toMatch(/\b09:00\b/);
  }, 30_000);

  it('night post about "at 9" → 21:00', async () => {
    const result = await extractMemories(
      [msgAt('Leo', 'jam session at 9 in the barn', 20, 30)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/21:00|21\.00/);
  }, 30_000);

  it('morning post about "at 9" → 09:00', async () => {
    const result = await extractMemories(
      [msgAt('Jordan', 'yoga starts at 9 on the meadow', 7, 30)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/09:00|9:00/);
    expect(texts).not.toMatch(/21:00/);
  }, 30_000);

  it('"tomorrow at 9" from evening post → 09:00', async () => {
    const result = await extractMemories(
      [msgAt('Alex', 'forest walk tomorrow at 9, meet at the foyer', 21, 0)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/09:00|9:00/);
    expect(texts).not.toMatch(/21:00/);
  }, 30_000);

  it('"tomorrow evening at 9" → 21:00', async () => {
    const result = await extractMemories(
      [msgAt('Maya', 'bonfire tomorrow evening at 9 by the lake', 14, 0)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/21:00|21\.00/);
  }, 30_000);

  it('"tonight at 9" from afternoon post → 21:00', async () => {
    const result = await extractMemories(
      [msgAt('River', 'movie night tonight at 9 in the barn', 15, 0)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/21:00|21\.00/);
  }, 30_000);

  it('explicit "9pm" → 21:00 regardless of post time', async () => {
    const result = await extractMemories(
      [msgAt('Jordan', 'community dinner at 9pm in the main house', 10, 0)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/21:00|21\.00/);
  }, 30_000);

  it('explicit "9am" → 09:00 regardless of post time', async () => {
    const result = await extractMemories(
      [msgAt('Maya', 'breakfast buffet opens at 9am', 22, 0)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/09:00|9:00/);
    expect(texts).not.toMatch(/21:00/);
  }, 30_000);

  it('uses 24-hour format in output (not AM/PM)', async () => {
    const result = await extractMemories(
      [msgAt('Jordan', 'workshop at 3 in the garden', 11, 0)],
      [],
      'eq-time',
      'Treeweek III',
    );
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    const texts = result.memories.map((m) => m.text).join(' ');
    expect(texts).toMatch(/15:00|03:00/);
    expect(texts).not.toMatch(/\bam\b|\bpm\b/i);
  }, 30_000);
});
