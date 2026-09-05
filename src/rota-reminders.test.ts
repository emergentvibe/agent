import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  rotaImport,
  rotaHasPinged,
  rotaRecordPing,
  type RotaImportPayload,
  type RotaAssignment,
} from './rota-db.js';
import {
  buildMorningAnnouncement,
  startRotaReminders,
  stopRotaReminders,
  _resetForTests,
} from './rota-reminders.js';

const BLOCKS = [
  {
    key: 'lunch',
    label: 'Lunch Cooks',
    start: '10:30',
    end: '13:00',
    hours: 2.5,
    slots: 3,
  },
  {
    key: 'dish1',
    label: 'Dish Team',
    start: '11:30',
    end: '12:30',
    hours: 1.0,
    slots: 4,
  },
  {
    key: 'dinner',
    label: 'Dinner Cooks',
    start: '14:00',
    end: '18:00',
    hours: 4.0,
    slots: 4,
  },
  {
    key: 'dish3',
    label: 'Dish Team',
    start: '19:00',
    end: '21:00',
    hours: 2.0,
    slots: 4,
  },
];

function makePayload(date?: string): RotaImportPayload {
  const d = date || '2026-09-22';
  return {
    version: '2026-09-19T14:22:00Z-test',
    timezone: 'Europe/Berlin',
    blocks: BLOCKS,
    big_nights: [1],
    assignments: [
      {
        id: 'd1-lunch-1',
        day: 1,
        date: d,
        block: 'lunch',
        block_label: 'Lunch Cooks',
        slot: 1,
        start: '10:30',
        end: '13:00',
        hours: 2.5,
        weight: 2.5,
        rota_key: '@alice',
        name: 'Alice',
        telegram: '@alice',
      },
      {
        id: 'd1-lunch-2',
        day: 1,
        date: d,
        block: 'lunch',
        block_label: 'Lunch Cooks',
        slot: 2,
        start: '10:30',
        end: '13:00',
        hours: 2.5,
        weight: 2.5,
        rota_key: '@bob',
        name: 'Bob',
        telegram: '@bob',
      },
      {
        id: 'd1-dinner-1',
        day: 1,
        date: d,
        block: 'dinner',
        block_label: 'Dinner Cooks',
        slot: 1,
        start: '14:00',
        end: '18:00',
        hours: 4.0,
        weight: 4.0,
        rota_key: '@carol',
        name: 'Carol',
        telegram: '@carol',
      },
      {
        id: 'd1-open-1',
        day: 1,
        date: d,
        block: 'dish3',
        block_label: 'Dish Team',
        slot: 1,
        start: '19:00',
        end: '21:00',
        hours: 2.0,
        weight: 4.0,
        rota_key: null,
        name: null,
        telegram: null,
      },
    ],
  };
}

beforeEach(() => {
  _initTestDatabase();
  _resetForTests();
});

afterEach(() => {
  stopRotaReminders();
});

describe('buildMorningAnnouncement', () => {
  it('returns empty string for no assignments', () => {
    expect(buildMorningAnnouncement('2026-09-22', [])).toBe('');
  });

  it('builds announcement with blocks grouped', () => {
    rotaImport(makePayload());
    const assignments: RotaAssignment[] = [
      {
        id: 'd1-lunch-1',
        day: 1,
        date: '2026-09-22',
        block: 'lunch',
        block_label: 'Lunch Cooks',
        slot: 1,
        start: '10:30',
        end: '13:00',
        hours: 2.5,
        weight: 2.5,
        original_person: '@alice',
        original_name: 'Alice',
        original_telegram: '@alice',
        original_telegram_id: null,
        current_person: '@alice',
        current_name: 'Alice',
        current_telegram: '@alice',
        state: 'assigned',
        note: null,
      },
      {
        id: 'd1-dinner-1',
        day: 1,
        date: '2026-09-22',
        block: 'dinner',
        block_label: 'Dinner Cooks',
        slot: 1,
        start: '14:00',
        end: '18:00',
        hours: 4.0,
        weight: 4.0,
        original_person: '@carol',
        original_name: 'Carol',
        original_telegram: '@carol',
        original_telegram_id: null,
        current_person: '@carol',
        current_name: 'Carol',
        current_telegram: '@carol',
        state: 'assigned',
        note: null,
      },
    ];

    const text = buildMorningAnnouncement('2026-09-22', assignments);
    expect(text).toContain('Kitchen shifts for');
    expect(text).toContain('Lunch Cooks');
    expect(text).toContain('Alice');
    expect(text).toContain('Dinner Cooks');
    expect(text).toContain('Carol');
  });

  it('shows open slot count', () => {
    const assignments: RotaAssignment[] = [
      {
        id: 'd1-open-1',
        day: 1,
        date: '2026-09-22',
        block: 'dish3',
        block_label: 'Dish Team',
        slot: 1,
        start: '19:00',
        end: '21:00',
        hours: 2.0,
        weight: 4.0,
        original_person: null,
        original_name: null,
        original_telegram: null,
        original_telegram_id: null,
        current_person: null,
        current_name: null,
        current_telegram: null,
        state: 'open',
        note: null,
      },
    ];

    const text = buildMorningAnnouncement('2026-09-22', assignments);
    expect(text).toContain('1 open slot');
    expect(text).toContain('tap to claim');
  });

  it('shows cover needed for open shifts', () => {
    const assignments: RotaAssignment[] = [
      {
        id: 'd1-lunch-1',
        day: 1,
        date: '2026-09-22',
        block: 'lunch',
        block_label: 'Lunch Cooks',
        slot: 1,
        start: '10:30',
        end: '13:00',
        hours: 2.5,
        weight: 2.5,
        original_person: '@alice',
        original_name: 'Alice',
        original_telegram: '@alice',
        original_telegram_id: '99001',
        current_person: null,
        current_name: null,
        current_telegram: null,
        state: 'open',
        note: null,
      },
    ];

    const text = buildMorningAnnouncement('2026-09-22', assignments);
    expect(text).toContain('Alice @alice — cover needed');
  });
});

describe('notification dedup', () => {
  beforeEach(() => {
    rotaImport(makePayload());
  });

  it('rotaHasPinged returns false before recording', () => {
    expect(rotaHasPinged('d1-lunch-1', 'dm_99001')).toBe(false);
  });

  it('rotaRecordPing + rotaHasPinged round trip', () => {
    rotaRecordPing('d1-lunch-1', 'dm_99001');
    expect(rotaHasPinged('d1-lunch-1', 'dm_99001')).toBe(true);
    expect(rotaHasPinged('d1-lunch-1', 'dm_99002')).toBe(false);
  });
});

describe('startRotaReminders / stopRotaReminders', () => {
  it('starts and stops without errors', () => {
    const callbacks = {
      sendToShiftsTopic: vi.fn().mockResolvedValue(undefined),
      sendDm: vi.fn().mockResolvedValue(undefined),
    };

    startRotaReminders(callbacks);
    stopRotaReminders();
  });

  it('does not double-start', () => {
    const callbacks = {
      sendToShiftsTopic: vi.fn().mockResolvedValue(undefined),
      sendDm: vi.fn().mockResolvedValue(undefined),
    };

    startRotaReminders(callbacks);
    startRotaReminders(callbacks);
    stopRotaReminders();
  });
});
