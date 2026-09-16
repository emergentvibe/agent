import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../rota-db.js', () => ({
  rotaGetByDate: vi.fn().mockReturnValue([]),
  rotaGetByTelegramId: vi.fn().mockReturnValue([]),
  rotaGetCoveredByPerson: vi.fn().mockReturnValue([]),
  rotaGetOpenSlots: vi.fn().mockReturnValue([]),
}));

vi.mock('../db.js', () => ({
  getUserTotal: vi.fn().mockReturnValue(0),
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getToday: vi.fn().mockReturnValue('2025-09-25'),
    TELEGRAM_BOT_USERNAME: 'testbot',
  };
});

vi.mock('./schedule.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getTodaySchedule: vi.fn().mockReturnValue(null),
    getFullWeekSchedule: vi.fn().mockReturnValue([]),
    formatDate: vi.fn((d: string) => d),
    getEventPhase: vi.fn().mockReturnValue('during'),
    getScheduleForDate: vi.fn().mockReturnValue(null),
  };
});

vi.mock('./schedule-refresh.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getCachedUpdates: vi.fn().mockReturnValue([]),
    getCacheAge: vi.fn().mockReturnValue(Infinity),
  };
});

import {
  rotaGetByTelegramId,
  rotaGetCoveredByPerson,
  rotaGetOpenSlots,
} from '../rota-db.js';
import type { RotaAssignment } from '../rota-db.js';
import { renderToday, renderMyShifts } from './templates.js';

function makeAssignment(overrides: Partial<RotaAssignment>): RotaAssignment {
  return {
    id: 'a1',
    day: 4,
    date: '2025-09-25',
    block: 'lunch_cook',
    block_label: 'Lunch Cooks',
    slot: 1,
    start: '10:30',
    end: '13:00',
    hours: 2.5,
    weight: 1,
    original_person: 'p1',
    original_name: 'Alice',
    original_telegram: '@alice',
    original_telegram_id: '111',
    current_person: 'p1',
    current_name: 'Alice',
    current_telegram: '@alice',
    state: 'assigned',
    note: null,
    ...overrides,
  };
}

describe('Phase F Polish: Hero card shift state', () => {
  beforeEach(() => {
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([]);
  });

  it('excludes released (open) shifts from hero card', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({ state: 'open', start: '14:00', end: '18:00' }),
    ]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([]);

    const html = renderToday('111');
    expect(html).not.toContain('Your next shift');
    expect(html).toContain('No more shifts');
  });

  it('excludes covered (someone else took it) shifts from hero card', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({
        state: 'covered',
        current_person: 'p2',
        current_name: 'Bob',
        start: '14:00',
        end: '18:00',
      }),
    ]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([]);

    const html = renderToday('111');
    expect(html).not.toContain('Your next shift');
    expect(html).toContain('No more shifts');
  });

  it('shows assigned shift in hero card', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({ state: 'assigned', start: '14:00', end: '18:00' }),
    ]);

    const html = renderToday('111');
    expect(html).toContain('Your next shift');
    expect(html).toContain('Lunch Cooks');
  });

  it('shows shift you picked up with "Covering for" label', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([
      makeAssignment({
        id: 'a2',
        state: 'covered',
        original_name: 'Charlie',
        current_person: '111',
        current_name: 'You',
        start: '14:00',
        end: '18:00',
      }),
    ]);

    const html = renderToday('111');
    expect(html).toContain('Covering for Charlie');
    expect(html).toContain('Lunch Cooks');
  });

  it('does not show "Can\'t make it" on a covering shift', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([
      makeAssignment({
        state: 'covered',
        original_name: 'Charlie',
        current_person: '111',
        start: '14:00',
        end: '18:00',
      }),
    ]);

    const html = renderToday('111');
    expect(html).not.toContain("Can't make it");
  });
});

describe('Phase F Polish: My Shifts state badges', () => {
  beforeEach(() => {
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([]);
  });

  it('shows "released" badge for open shifts', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({ state: 'open' }),
    ]);

    const html = renderMyShifts('111');
    expect(html).toContain('released');
    expect(html).toContain('card-open');
    expect(html).not.toContain("Can't make it");
  });

  it('shows "covered" badge and cover name for covered shifts', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({
        state: 'covered',
        current_person: 'p2',
        current_name: 'Bob',
      }),
    ]);

    const html = renderMyShifts('111');
    expect(html).toContain('covered');
    expect(html).toContain('badge-covered');
    expect(html).toContain('now: Bob');
  });

  it('shows "Shifts you picked up" section', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({ state: 'assigned' }),
    ]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([
      makeAssignment({
        id: 'a3',
        date: '2025-09-26',
        state: 'covered',
        original_name: 'Charlie',
        current_person: '111',
      }),
    ]);

    const html = renderMyShifts('111');
    expect(html).toContain('Shifts you picked up');
    expect(html).toContain('covering');
    expect(html).toContain('for: Charlie');
  });

  it('shows "upcoming" badge and cover button for assigned future shifts', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({ state: 'assigned', date: '2025-09-26' }),
    ]);

    const html = renderMyShifts('111');
    expect(html).toContain('upcoming');
    expect(html).toContain("Can't make it");
  });
});

describe('Phase F Polish: Nav tabs', () => {
  it('does not include The Week tab', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([]);
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);

    const html = renderToday(null);
    expect(html).not.toContain('The Week');
    expect(html).not.toContain('/week');
    expect(html).toContain('Today');
    expect(html).toContain('My Stuff');
    expect(html).toContain('Lend a Hand');
  });
});

describe('Phase F Polish: Hero card today-only', () => {
  beforeEach(() => {
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);
    vi.mocked(rotaGetCoveredByPerson).mockReturnValue([]);
  });

  it('does not show hero card when next shift is on a different day', () => {
    vi.mocked(rotaGetByTelegramId).mockReturnValue([
      makeAssignment({
        state: 'assigned',
        date: '2025-09-26',
        start: '14:00',
        end: '18:00',
      }),
    ]);
    const html = renderToday('111');
    expect(html).not.toContain('Your next shift');
    expect(html).not.toContain('No more shifts');
  });
});
