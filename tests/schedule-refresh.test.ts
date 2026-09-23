import { describe, it, expect } from 'vitest';
import { isDateRelevant } from '../src/web/schedule-refresh.js';

describe('isDateRelevant', () => {
  describe('full "September" format', () => {
    it('matches memory to correct day', () => {
      expect(isDateRelevant('Dinner on 22 September is at 7pm', 22)).toBe(true);
    });

    it('rejects memory for wrong day', () => {
      expect(isDateRelevant('Dinner on 22 September is at 7pm', 23)).toBe(false);
    });

    it('handles "Sunday 27 September"', () => {
      expect(isDateRelevant('Party on Sunday 27 September', 27)).toBe(true);
      expect(isDateRelevant('Party on Sunday 27 September', 22)).toBe(false);
    });
  });

  describe('abbreviated "Sep" format', () => {
    it('matches memory to correct day', () => {
      expect(isDateRelevant('Hotseat at 11:00 on Wed 23 Sep', 23)).toBe(true);
    });

    it('rejects memory for wrong day', () => {
      expect(isDateRelevant('Hotseat at 11:00 on Wed 23 Sep', 22)).toBe(false);
    });

    it('handles "Tue 22 Sep"', () => {
      expect(isDateRelevant('Dinner at 7pm on Tue 22 Sep', 22)).toBe(true);
      expect(isDateRelevant('Dinner at 7pm on Tue 22 Sep', 23)).toBe(false);
    });

    it('handles "Photography teaching on Wed 23 Sep at 2pm"', () => {
      expect(
        isDateRelevant(
          'Photography teaching on Wed 23 Sep at 2pm in the foyer',
          23,
        ),
      ).toBe(true);
      expect(
        isDateRelevant(
          'Photography teaching on Wed 23 Sep at 2pm in the foyer',
          24,
        ),
      ).toBe(false);
    });
  });

  describe('"Day N" format', () => {
    it('maps Day 1 to Sep 22', () => {
      expect(isDateRelevant('Day 1 is arrival day', 22)).toBe(true);
      expect(isDateRelevant('Day 1 is arrival day', 23)).toBe(false);
    });

    it('maps Day 2 to Sep 23', () => {
      expect(isDateRelevant('Day 2 has workshops', 23)).toBe(true);
      expect(isDateRelevant('Day 2 has workshops', 22)).toBe(false);
    });

    it('maps Day 8 to Sep 29', () => {
      expect(isDateRelevant('Day 8 is departure', 29)).toBe(true);
      expect(isDateRelevant('Day 8 is departure', 22)).toBe(false);
    });

    it('ignores Day numbers outside 1-8 range', () => {
      expect(isDateRelevant('Day 10 something', 22)).toBe(true);
    });
  });

  describe('no date mentioned', () => {
    it('passes for any day (dateless memories are relevant everywhere)', () => {
      expect(isDateRelevant('Yoga is great', 22)).toBe(true);
      expect(isDateRelevant('Yoga is great', 29)).toBe(true);
    });
  });

  describe('multiple dates', () => {
    it('matches if target is any of the mentioned dates', () => {
      expect(
        isDateRelevant('Event runs 22 Sep and 23 Sep', 22),
      ).toBe(true);
      expect(
        isDateRelevant('Event runs 22 Sep and 23 Sep', 23),
      ).toBe(true);
    });

    it('rejects if target is none of the mentioned dates', () => {
      expect(
        isDateRelevant('Event runs 22 Sep and 23 Sep', 24),
      ).toBe(false);
    });
  });

  describe('mixed formats', () => {
    it('handles Sep + Day N in same memory', () => {
      expect(
        isDateRelevant('On 22 Sep (Day 1) arrivals begin', 22),
      ).toBe(true);
      expect(
        isDateRelevant('On 22 Sep (Day 1) arrivals begin', 23),
      ).toBe(false);
    });
  });
});
