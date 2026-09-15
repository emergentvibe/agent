import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  getToday: vi.fn().mockReturnValue('2025-09-25'),
}));

import { buildScheduleQueries } from './schedule-refresh.js';

describe('Schedule refresh: date-aware queries', () => {
  it('builds queries containing today formatted date', () => {
    const queries = buildScheduleQueries();

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('Thursday');
    expect(queries[0]).toContain('25');
    expect(queries[0]).toContain('September');
    expect(queries[0]).toContain('schedule changes');
    expect(queries[1]).toContain('cancelled events');
    expect(queries[1]).toContain('Thursday');
    expect(queries[2]).toContain('new events');
    expect(queries[2]).toContain('Thursday');
  });

  it('does not contain "today" as a literal word in queries', () => {
    const queries = buildScheduleQueries();

    for (const q of queries) {
      expect(q.toLowerCase()).not.toMatch(/\btoday\b/);
    }
  });
});
