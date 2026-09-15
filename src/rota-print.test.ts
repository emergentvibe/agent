import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  rotaImport,
  rotaBindTelegramId,
  rotaRelease,
  rotaClaim,
  rotaGetById,
  type RotaImportPayload,
} from './rota-db.js';
import { attendeeImport } from './attendee-db.js';
import {
  generateRotaPdf,
  generateWeeklyRotaPdf,
  parsePrintArgs,
  resolveDisplayIdentity,
  resolveShortIdentifier,
  resolveCovererIdentifier,
  buildAttendeeMap,
} from './rota-print.js';

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

function makePayload(): RotaImportPayload {
  return {
    version: '2026-09-19T14:22:00Z-test',
    timezone: 'Europe/Berlin',
    blocks: BLOCKS,
    big_nights: [1],
    assignments: [
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
        rota_key: '@alice',
        name: 'Alice',
        telegram: '@alice',
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
        rota_key: '@carol',
        name: 'Carol',
        telegram: '@carol',
      },
      {
        id: 'd1-dish3-1',
        day: 1,
        date: '2026-09-22',
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
});

describe('generateRotaPdf', () => {
  it('returns error when no rota loaded', async () => {
    const result = await generateRotaPdf('2026-09-22');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No rota loaded');
    }
  });

  it('returns error for date with no shifts', async () => {
    rotaImport(makePayload());
    const result = await generateRotaPdf('2026-09-30');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No shifts scheduled');
    }
  });

  it('generates a valid PDF buffer', async () => {
    rotaImport(makePayload());
    const result = await generateRotaPdf('2026-09-22');
    expect('buffer' in result).toBe(true);
    if ('buffer' in result) {
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.buffer.length).toBeGreaterThan(100);
      expect(result.buffer.slice(0, 5).toString()).toBe('%PDF-');
      expect(result.filename).toBe('shifts-2026-09-22.pdf');
    }
  });

  it('generates PDF with covered shifts', async () => {
    rotaImport(makePayload());

    rotaBindTelegramId('@alice', '99001');
    rotaBindTelegramId('@carol', '99003');
    rotaRelease('d1-lunch-1', '99001');
    rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');

    const result = await generateRotaPdf('2026-09-22');
    expect('buffer' in result).toBe(true);
    if ('buffer' in result) {
      expect(result.buffer.slice(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('handles open (unfilled) slots', async () => {
    rotaImport(makePayload());
    const result = await generateRotaPdf('2026-09-22');
    expect('buffer' in result).toBe(true);
  });
});

describe('generateWeeklyRotaPdf', () => {
  it('returns error when no rota loaded', async () => {
    const result = await generateWeeklyRotaPdf();
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No rota loaded');
    }
  });

  it('generates a valid landscape PDF', async () => {
    rotaImport(makePayload());
    const result = await generateWeeklyRotaPdf();
    expect('buffer' in result).toBe(true);
    if ('buffer' in result) {
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.buffer.length).toBeGreaterThan(100);
      expect(result.buffer.slice(0, 5).toString()).toBe('%PDF-');
      expect(result.filename).toContain('shifts-week-');
    }
  });
});

describe('covered shift identity resolution', () => {
  function importWithAttendees() {
    rotaImport(makePayload());
    attendeeImport({
      version: 'test',
      event: 'test',
      attendees: [
        { name: 'Alice', telegram_handle: '@alice', person_id: 'p-alice' },
        { name: 'Carol', telegram_handle: '@carol', person_id: 'p-carol' },
      ],
    });
  }

  function coveredAssignment() {
    importWithAttendees();
    rotaBindTelegramId('@alice', '99001');
    rotaBindTelegramId('@carol', '99003');
    rotaRelease('d1-lunch-1', '99001');
    rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');
  }

  it('resolveShortIdentifier returns original handle, not coverer', () => {
    coveredAssignment();
    const a = rotaGetById('d1-lunch-1')!;
    const map = buildAttendeeMap();
    const result = resolveShortIdentifier(a, map);
    expect(result).toBe('@alice');
  });

  it('resolveCovererIdentifier returns coverer handle', () => {
    coveredAssignment();
    const a = rotaGetById('d1-lunch-1')!;
    const map = buildAttendeeMap();
    const result = resolveCovererIdentifier(a, map);
    expect(result).toBe('@carol');
  });

  it('resolveCovererIdentifier falls back to attendee map when handle missing', () => {
    rotaImport(makePayload());
    attendeeImport({
      version: 'test',
      event: 'test',
      attendees: [
        { name: 'Alice', telegram_handle: '@alice', person_id: 'p-alice' },
        { name: 'Carol', telegram_handle: '@carol', person_id: 'p-carol' },
      ],
    });
    rotaBindTelegramId('@alice', '99001');
    rotaRelease('d1-lunch-1', '99001');
    // Claim with telegram ID but no @handle
    rotaClaim('d1-lunch-1', '99003', 'Carol', null);

    const a = rotaGetById('d1-lunch-1')!;
    const map = buildAttendeeMap();
    const result = resolveCovererIdentifier(a, map);
    expect(result).toBe('@carol');
  });

  it('resolveDisplayIdentity shows original → coverer for covered shifts', () => {
    coveredAssignment();
    const a = rotaGetById('d1-lunch-1')!;
    const map = buildAttendeeMap();
    const result = resolveDisplayIdentity(a, map);
    expect(result).toContain('Alice');
    expect(result).toContain('@alice');
    expect(result).toContain('CAROL');
    expect(result.toUpperCase()).toContain('@CAROL');
    expect(result).toContain('→');
    expect(result).toContain('covering');
  });

  it('resolveDisplayIdentity coverer contact uses attendee fallback', () => {
    rotaImport(makePayload());
    attendeeImport({
      version: 'test',
      event: 'test',
      attendees: [
        { name: 'Alice', telegram_handle: '@alice', person_id: 'p-alice' },
        { name: 'Carol', telegram_handle: '@carol', person_id: 'p-carol' },
      ],
    });
    rotaBindTelegramId('@alice', '99001');
    rotaRelease('d1-lunch-1', '99001');
    rotaClaim('d1-lunch-1', '99003', 'Carol', null);

    const a = rotaGetById('d1-lunch-1')!;
    const map = buildAttendeeMap();
    const result = resolveDisplayIdentity(a, map);
    expect(result.toUpperCase()).toContain('@CAROL');
    expect(result).toContain('covering');
  });

  it('weekly PDF generates without error when shifts are covered', async () => {
    coveredAssignment();
    const result = await generateWeeklyRotaPdf();
    expect('buffer' in result).toBe(true);
    if ('buffer' in result) {
      expect(result.buffer.slice(0, 5).toString()).toBe('%PDF-');
    }
  });
});

describe('parsePrintArgs', () => {
  beforeEach(() => {
    delete process.env.DATE_OVERRIDE;
  });

  it('defaults to tomorrow with no args', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expected = tomorrow.toISOString().slice(0, 10);
    expect(parsePrintArgs('/admin-rota-print')).toBe(expected);
  });

  it('handles "today"', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(parsePrintArgs('/admin-rota-print today')).toBe(today);
  });

  it('handles explicit date', () => {
    expect(parsePrintArgs('/admin-rota-print 2026-09-25')).toBe('2026-09-25');
  });

  it('handles "tomorrow" explicitly', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expected = tomorrow.toISOString().slice(0, 10);
    expect(parsePrintArgs('/admin-rota-print tomorrow')).toBe(expected);
  });
});
