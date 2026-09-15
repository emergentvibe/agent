import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  getToday: vi.fn().mockReturnValue('2025-09-25'),
}));

vi.mock('../mem0-client.js', () => ({
  searchMemories: vi.fn(),
}));

import {
  buildScheduleQueries,
  getCachedUpdates,
  setCachedUpdates,
} from './schedule-refresh.js';
import { searchMemories } from '../mem0-client.js';

describe('Schedule refresh: date-aware queries', () => {
  it('builds queries containing today formatted date', () => {
    const queries = buildScheduleQueries();

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('Thursday');
    expect(queries[0]).toContain('25');
    expect(queries[0]).toContain('September');
    expect(queries[0]).toContain('meal');
    expect(queries[1]).toContain('cancelled');
    expect(queries[1]).toContain('Thursday');
    expect(queries[2]).toContain('happening');
    expect(queries[2]).toContain('Thursday');
  });

  it('does not contain "today" as a literal word in queries', () => {
    const queries = buildScheduleQueries();

    for (const q of queries) {
      expect(q.toLowerCase()).not.toMatch(/\btoday\b/);
    }
  });
});

describe('Schedule refresh: top-N per query', () => {
  it('takes top N results per query, deduplicating across queries', async () => {
    const queryResults: Record<string, typeof mockResults> = {};
    const mockResults = [
      {
        id: '1',
        memory: 'Dinner at 6pm on Thu 25 Sep',
        user_id: 'u',
        score: 0.63,
        created_at: '2026-09-14T09:00:00Z',
      },
      {
        id: '2',
        memory: 'Yoga cancelled Thu 25 Sep',
        user_id: 'u',
        score: 0.52,
        created_at: '2026-09-14T09:00:00Z',
      },
      {
        id: '3',
        memory: 'Bonfire at 9pm Thu 25 Sep',
        user_id: 'u',
        score: 0.44,
        created_at: '2026-09-14T09:00:00Z',
      },
      {
        id: '4',
        memory: 'Kitchen hours 6am-11pm',
        user_id: 'u',
        score: 0.4,
        created_at: '2026-09-14T09:00:00Z',
      },
      {
        id: '5',
        memory: 'Alex is a painter',
        user_id: 'u',
        score: 0.22,
        created_at: '2026-09-14T09:00:00Z',
      },
    ];

    // Each query returns same 5 results; top-3 per query means
    // first query takes 1,2,3 — second query dedupes and takes 4 — third gets 5
    vi.mocked(searchMemories).mockResolvedValue(mockResults);

    const { refreshScheduleCache } = await import('./schedule-refresh.js');
    await (refreshScheduleCache as any)({
      registeredGroups: () => ({
        '-100123': {
          chatId: -100123,
          folder: 'test',
          isMain: true,
          name: 'Test',
        },
      }),
    });

    const cached = getCachedUpdates();
    // 3 queries × top 3 = up to 9, but only 5 unique; id '5' (score 0.22) is above floor (0.15)
    expect(cached).toHaveLength(5);
    expect(cached[0].memory).toBe('Dinner at 6pm on Thu 25 Sep');
  });

  it('respects floor score — filters truly irrelevant results', async () => {
    const mockResults = [
      {
        id: '1',
        memory: 'Dinner at 6pm',
        user_id: 'u',
        score: 0.55,
        created_at: '2026-09-14T09:00:00Z',
      },
      {
        id: '2',
        memory: 'Random noise',
        user_id: 'u',
        score: 0.1,
        created_at: '2026-09-14T09:00:00Z',
      },
      {
        id: '3',
        memory: 'More noise',
        user_id: 'u',
        score: 0.08,
        created_at: '2026-09-14T09:00:00Z',
      },
    ];

    vi.mocked(searchMemories).mockResolvedValue(mockResults);

    const { refreshScheduleCache } = await import('./schedule-refresh.js');
    await (refreshScheduleCache as any)({
      registeredGroups: () => ({
        '-100123': {
          chatId: -100123,
          folder: 'test',
          isMain: true,
          name: 'Test',
        },
      }),
    });

    const cached = getCachedUpdates();
    // Only id '1' is above floor (0.15); ids 2 and 3 are below
    // First query: takes id 1, skips id 2 (below floor), skips id 3 (below floor) → 1 taken
    // Second query: dedupes id 1, skips id 2, skips id 3 → 0 new
    // Third query: same → 0 new
    expect(cached).toHaveLength(1);
    expect(cached[0].memory).toBe('Dinner at 6pm');
  });

  it('keeps memories with no score (cloud backend compat)', async () => {
    const mockResults = [
      {
        id: '1',
        memory: 'Dinner at 6pm',
        user_id: 'u',
        created_at: '2026-09-14T09:00:00Z',
      },
      {
        id: '2',
        memory: 'Yoga cancelled',
        user_id: 'u',
        created_at: '2026-09-14T09:00:00Z',
      },
    ];

    vi.mocked(searchMemories).mockResolvedValue(mockResults);

    const { refreshScheduleCache } = await import('./schedule-refresh.js');
    await (refreshScheduleCache as any)({
      registeredGroups: () => ({
        '-100123': {
          chatId: -100123,
          folder: 'test',
          isMain: true,
          name: 'Test',
        },
      }),
    });

    const cached = getCachedUpdates();
    // No score → passes floor check → kept
    expect(cached).toHaveLength(2);
  });
});
