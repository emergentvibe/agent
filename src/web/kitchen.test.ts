import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { rotaGetByDate, rotaGetOpenSlots } from '../rota-db.js';
import type { RotaAssignment } from '../rota-db.js';
import { renderKitchen } from './templates.js';

function makeAssignment(overrides: Partial<RotaAssignment>): RotaAssignment {
  return {
    id: 'a1',
    day: 4,
    date: '2025-09-25',
    block: 'lunch',
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

const LUNCH = (overrides: Partial<RotaAssignment> = {}) =>
  makeAssignment({
    id: 'lunch-1',
    block: 'lunch',
    block_label: 'Lunch Cooks',
    start: '10:30',
    end: '13:00',
    ...overrides,
  });

const DINNER = (overrides: Partial<RotaAssignment> = {}) =>
  makeAssignment({
    id: 'dinner-1',
    block: 'dinner',
    block_label: 'Dinner Cooks',
    start: '14:00',
    end: '18:00',
    ...overrides,
  });

const DISH = (overrides: Partial<RotaAssignment> = {}) =>
  makeAssignment({
    id: 'dish3-1',
    block: 'dish3',
    block_label: 'Dish Team',
    start: '19:00',
    end: '21:00',
    ...overrides,
  });

// Time fixed at 15:30 — lunch is past, dinner is now, dish is upcoming
describe('Kitchen tab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-25T15:30:00'));
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);
    vi.mocked(rotaGetByDate).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders with Kitchen nav tab', () => {
    const html = renderKitchen();
    expect(html).toContain('Kitchen');
    expect(html).toContain('/kitchen');
  });

  it('auto-refreshes every 60s', () => {
    const html = renderKitchen();
    expect(html).toContain('setTimeout');
    expect(html).toContain('60000');
    expect(html).toContain('auto-refreshes');
  });

  it('shows "No shifts today" when empty', () => {
    const html = renderKitchen();
    expect(html).toContain('No shifts today');
    expect(html).not.toContain('Right Now');
    expect(html).not.toContain('Up Next');
    expect(html).not.toContain('Done');
  });
});

describe('Kitchen: time categorization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-25T15:30:00'));
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);
    vi.mocked(rotaGetByDate).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "Right Now" for active block with NOW badge', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({ original_name: 'Chef A' }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('Right Now');
    expect(html).toContain('● NOW');
    expect(html).toContain('kitchen-now');
    expect(html).toContain('Dinner Cooks');
    expect(html).toContain('14:00');
  });

  it('shows "Up Next" for upcoming block without NOW badge', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DISH({ original_name: 'Washer A' }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('Up Next');
    expect(html).toContain('Dish Team');
    expect(html).toContain('19:00');
    expect(html).not.toContain('● NOW');
  });

  it('shows "Done" for past block (faded)', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      LUNCH({ original_name: 'Cook A' }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('Done');
    expect(html).toContain('kitchen-past');
    expect(html).toContain('Lunch Cooks');
  });

  it('orders sections: now → upcoming → done', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      LUNCH({ id: 'l1', original_name: 'A' }),
      DINNER({ id: 'd1', original_name: 'B' }),
      DISH({ id: 'di1', original_name: 'C' }),
    ]);

    const html = renderKitchen();
    const nowPos = html.indexOf('Right Now');
    const nextPos = html.indexOf('Up Next');
    const donePos = html.indexOf('Done');

    expect(nowPos).toBeGreaterThan(-1);
    expect(nextPos).toBeGreaterThan(nowPos);
    expect(donePos).toBeGreaterThan(nextPos);
  });
});

describe('Kitchen: personnel display', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-25T15:30:00'));
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);
    vi.mocked(rotaGetByDate).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows name with @handle as clickable Telegram link', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({ original_name: 'Alice', original_telegram: '@alice_tg' }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('Alice');
    expect(html).toContain('@alice_tg');
    expect(html).toContain('https://t.me/alice_tg');
    expect(html).toContain('kp-handle');
  });

  it('shows name without handle when none available', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({
        original_name: 'NoHandle',
        current_name: 'NoHandle',
        original_telegram: null,
        current_telegram: null,
      }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('NoHandle');
    expect(html).not.toContain('class="kp-handle"');
  });

  it('normalizes handle without @ prefix', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({ original_name: 'Bob', original_telegram: 'bob_bare' }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('@bob_bare');
    expect(html).toContain('https://t.me/bob_bare');
  });

  it('shows covered shift with coverer details', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({
        state: 'covered',
        original_name: 'Simon',
        original_telegram: '@simon',
        current_name: 'Alex',
        current_telegram: '@alex_cover',
        current_person: 'p2',
      }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('Alex');
    expect(html).toContain('@alex_cover');
    expect(html).toContain('https://t.me/alex_cover');
    expect(html).toContain('covering');
    expect(html).toContain('for Simon');
    expect(html).toContain('kp-covered');
    expect(html).toContain('badge-covered');
  });

  it('shows open shift with warning and claim button', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({
        state: 'open',
        original_name: 'LeftPerson',
        current_person: null,
        current_name: null,
        current_telegram: null,
      }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('⚠ OPEN');
    expect(html).toContain('was: LeftPerson');
    expect(html).toContain('claim');
    expect(html).toContain('kp-open');
    expect(html).toContain('btn-fire');
    expect(html).toContain('t.me/');
  });

  it('shows multiple people per block with mixed states', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({
        id: 'd1',
        slot: 1,
        original_name: 'Chef A',
        current_name: 'Chef A',
        original_telegram: '@chefA',
        current_telegram: '@chefA',
      }),
      DINNER({
        id: 'd2',
        slot: 2,
        original_name: 'Chef B',
        current_name: 'Chef B',
        original_telegram: '@chefB',
        current_telegram: '@chefB',
      }),
      DINNER({
        id: 'd3',
        slot: 3,
        state: 'covered',
        original_name: 'Chef C',
        current_name: 'Sub D',
        current_telegram: '@subD',
        current_person: 'px',
      }),
      DINNER({
        id: 'd4',
        slot: 4,
        state: 'open',
        original_name: 'Chef E',
        current_person: null,
        current_name: null,
        current_telegram: null,
      }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('Chef A');
    expect(html).toContain('@chefA');
    expect(html).toContain('Chef B');
    expect(html).toContain('Sub D');
    expect(html).toContain('for Chef C');
    expect(html).toContain('⚠ OPEN');
    expect(html).toContain('was: Chef E');
  });
});

describe('Kitchen: summary and tomorrow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-25T15:30:00'));
    vi.mocked(rotaGetOpenSlots).mockReturnValue([]);
    vi.mocked(rotaGetByDate).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows on-shift count and open slots in summary', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({ id: 'd1', slot: 1, state: 'assigned' }),
      DINNER({ id: 'd2', slot: 2, state: 'assigned' }),
      DINNER({
        id: 'd3',
        slot: 3,
        state: 'open',
        current_person: null,
        current_name: null,
      }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('2 on shift');
    expect(html).toContain('1 open slot');
  });

  it('omits open count when none', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({ id: 'd1', state: 'assigned' }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('1 on shift');
    expect(html).not.toContain('open slot');
  });

  it('pluralizes "open slots"', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([
      DINNER({
        id: 'd1',
        slot: 1,
        state: 'open',
        current_person: null,
        current_name: null,
      }),
      DINNER({
        id: 'd2',
        slot: 2,
        state: 'open',
        current_person: null,
        current_name: null,
      }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('open slots');
  });

  it('shows tomorrow preview when data exists', () => {
    vi.mocked(rotaGetByDate).mockImplementation((date: string) => {
      if (date === '2025-09-25') return [];
      if (date === '2025-09-26')
        return [
          makeAssignment({
            id: 'tm-1',
            date: '2025-09-26',
            block: 'lunch',
            block_label: 'Lunch Cooks',
            start: '10:30',
            end: '13:00',
            original_name: 'Tomorrow Cook',
            current_name: 'Tomorrow Cook',
            original_telegram: '@tmcook',
            current_telegram: '@tmcook',
          }),
        ];
      return [];
    });

    const html = renderKitchen();
    expect(html).toContain('Tomorrow');
    expect(html).toContain('Tomorrow Cook');
    expect(html).toContain('@tmcook');
    expect(html).toContain('Lunch Cooks');
  });

  it('omits tomorrow section when no data', () => {
    vi.mocked(rotaGetByDate).mockReturnValue([]);

    const html = renderKitchen();
    expect(html).not.toContain('Tomorrow');
  });

  it('shows open count badge in nav', () => {
    vi.mocked(rotaGetOpenSlots).mockReturnValue([
      makeAssignment({ id: 'o1', state: 'open', date: '2025-09-25' }),
      makeAssignment({ id: 'o2', state: 'open', date: '2025-09-26' }),
    ]);

    const html = renderKitchen();
    expect(html).toContain('class="badge"');
    expect(html).toContain('>2<');
  });
});
