/**
 * Extraction boundary tests — verifies that the narrowed extraction scope
 * correctly includes event/activity content and excludes personal information.
 *
 * Requires ANTHROPIC_API_KEY (real Haiku calls). Cost: ~$0.01 per run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { extractMemories, _setClient } from '../src/extraction.js';
import type { NewMessage } from '../src/types.js';

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

function msg(sender: string, content: string): NewMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    chat_jid: 'tg:test-group',
    sender: `tg:${sender.toLowerCase()}`,
    sender_name: sender,
    content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
  };
}

describe.skipIf(!HAS_API_KEY)(
  'extraction boundaries (real Haiku)',
  () => {
    afterAll(() => _setClient(null));

    it('extracts events and excludes personal info', async () => {
      const result = await extractMemories(
        [
          msg('Alex', 'Workshop at 3pm in the garden today'),
          msg('Jordan', 'Dinner moved from 7 to 6:30 tonight'),
          msg('Priya', 'Anyone want to do a music jam?'),
          msg('River', 'Hot water is out in building B'),
          msg('Sam', "I'm vegan and gluten-free"),
          msg('Casey', 'My pronouns are they/them'),
          msg('Taylor', "I feel awful, think I'm getting sick"),
          msg('Morgan', "I'm on kitchen duty tomorrow morning"),
        ],
        [],
        'boundary-test',
        'Treeweek III',
      );

      const texts = result.memories
        .map((m) => m.text.toLowerCase())
        .join(' ');

      // Should extract: events, schedule changes, proposals, facility status
      expect(texts).toMatch(/workshop|3pm|garden/);
      expect(texts).toMatch(/dinner|6:30|moved/);
      expect(texts).toMatch(/music jam/);
      expect(texts).toMatch(/hot water|building b/);

      // Should NOT extract: diet, pronouns, health, rota
      expect(texts).not.toMatch(/vegan|gluten/);
      expect(texts).not.toMatch(/pronouns|they\/them/);
      expect(texts).not.toMatch(/sick|awful/);
      expect(texts).not.toMatch(/kitchen duty/);
    }, 30_000);

    it('extracts subscription-matched content', async () => {
      const result = await extractMemories(
        [
          msg(
            'Sam',
            'Just showed everyone some amazing photos from the lake this morning',
          ),
        ],
        [],
        'boundary-test',
        'Treeweek III',
        ['photography'],
      );

      expect(result.memories.length).toBeGreaterThanOrEqual(1);
      const texts = result.memories
        .map((m) => m.text.toLowerCase())
        .join(' ');
      expect(texts).toMatch(/photo/);
    }, 30_000);
  },
);
