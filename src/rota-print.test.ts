import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  rotaImport,
  rotaBindTelegramId,
  rotaRelease,
  rotaClaim,
  type RotaImportPayload,
} from './rota-db.js';
import { generateRotaPdf, parsePrintArgs } from './rota-print.js';

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

describe('parsePrintArgs', () => {
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
