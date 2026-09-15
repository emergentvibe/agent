import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  getToday: vi.fn().mockReturnValue('2025-09-25'),
}));

vi.mock('../mem0-client.js', () => ({
  searchMemories: vi.fn(),
}));

import { buildScheduleQueries, getCachedUpdates, setCachedUpdates } from './schedule-refresh.js';
import { searchMemories } from '../mem0-client.js';

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

describe('Schedule refresh: score thresholding', () => {
  it('filters out low-score memories from Mem0 results', async () => {
    const mockResults = [
      { id: '1', memory: 'Dinner at 6pm', user_id: 'u', score: 0.575, created_at: '2026-09-14T09:00:00Z' },
      { id: '2', memory: 'Conflicting times', user_id: 'u', score: 0.535, created_at: '2026-09-14T09:00:00Z' },
      { id: '3', memory: 'Kitchen open 6am-11pm', user_id: 'u', score: 0.418, created_at: '2026-09-14T09:00:00Z' },
      { id: '4', memory: 'Time is 9pm', user_id: 'u', score: 0.411, created_at: '2026-09-14T09:00:00Z' },
      { id: '5', memory: 'Sauna heated', user_id: 'u', score: 0.329, created_at: '2026-09-14T09:00:00Z' },
    ];

    vi.mocked(searchMemories).mockResolvedValue(mockResults);

    const { refreshScheduleCache } = await import('./schedule-refresh.js');
    await (refreshScheduleCache as any)({
      registeredGroups: () => ({
        '-100123': { chatId: -100123, folder: 'test', isMain: true, name: 'Test' },
      }),
    });

    const cached = getCachedUpdates();
    expect(cached).toHaveLength(2);
    expect(cached[0].memory).toBe('Dinner at 6pm');
    expect(cached[1].memory).toBe('Conflicting times');
  });

  it('keeps memories with no score (cloud backend compat)', async () => {
    const mockResults = [
      { id: '1', memory: 'Dinner at 6pm', user_id: 'u', created_at: '2026-09-14T09:00:00Z' },
      { id: '2', memory: 'Kitchen open', user_id: 'u', score: 0.3, created_at: '2026-09-14T09:00:00Z' },
    ];

    vi.mocked(searchMemories).mockResolvedValue(mockResults);

    const { refreshScheduleCache } = await import('./schedule-refresh.js');
    await (refreshScheduleCache as any)({
      registeredGroups: () => ({
        '-100123': { chatId: -100123, folder: 'test', isMain: true, name: 'Test' },
      }),
    });

    const cached = getCachedUpdates();
    expect(cached).toHaveLength(1);
    expect(cached[0].memory).toBe('Dinner at 6pm');
  });
});
