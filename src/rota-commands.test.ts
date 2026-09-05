import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './db.js';
import {
  rotaImport,
  rotaGetMeta,
  rotaGetById,
  rotaBindTelegramId,
  rotaRelease,
  rotaClaim,
  rotaGetByTelegramId,
  rotaGetByHandle,
  rotaGetOpenSlots,
  type RotaImportPayload,
} from './rota-db.js';
import { rotaCommandEntries } from './rota-commands.js';

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
    key: 'dish2',
    label: 'Dish Team',
    start: '15:00',
    end: '17:00',
    hours: 2.0,
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
    big_nights: [1, 4, 6],
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
        id: 'd1-dish1-1',
        day: 1,
        date: '2026-09-22',
        block: 'dish1',
        block_label: 'Dish Team',
        slot: 1,
        start: '11:30',
        end: '12:30',
        hours: 1.0,
        weight: 1.0,
        rota_key: '@bob',
        name: 'Bob',
        telegram: '@bob',
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
        rota_key: '@dave',
        name: 'Dave',
        telegram: '@dave',
      },
      {
        id: 'd1-open-1',
        day: 1,
        date: '2026-09-22',
        block: 'dish2',
        block_label: 'Dish Team',
        slot: 1,
        start: '15:00',
        end: '17:00',
        hours: 2.0,
        weight: 2.0,
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

describe('rotaCommandEntries', () => {
  it('returns all rota commands as local', () => {
    const entries = rotaCommandEntries();
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.every((e) => e.local === true)).toBe(true);
    const names = entries.map((e) => e.command);
    expect(names).toContain('cover');
    expect(names).toContain('shifts');
    expect(names).toContain('myrota');
    expect(names).toContain('leaveearly');
    expect(names).toContain('hands');
    expect(names).toContain('h');
  });
});

describe('lazy identity binding via rota operations', () => {
  beforeEach(() => {
    rotaImport(makePayload());
  });

  it('binds telegram ID on first lookup by handle', () => {
    // Simulate what resolveIdentity does
    let rows = rotaGetByTelegramId('99001');
    expect(rows.length).toBe(0);

    rows = rotaGetByHandle('@alice');
    expect(rows.length).toBe(1);

    rotaBindTelegramId('@alice', '99001');
    rows = rotaGetByTelegramId('99001');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('d1-lunch-1');
  });
});

describe('cover flow: release → post → claim', () => {
  beforeEach(() => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    rotaBindTelegramId('@carol', '99003');
    rotaBindTelegramId('@dave', '99004');
  });

  it('release changes state to open, claim changes to covered', () => {
    const rel = rotaRelease('d1-lunch-1', '99001');
    expect(rel.ok).toBe(true);

    const opened = rotaGetById('d1-lunch-1')!;
    expect(opened.state).toBe('open');
    expect(opened.current_person).toBeNull();

    const claim = rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');
    expect(claim).toEqual({ ok: true });

    const covered = rotaGetById('d1-lunch-1')!;
    expect(covered.state).toBe('covered');
    expect(covered.current_name).toBe('Dave');
    expect(covered.original_person).toBe('@alice');
  });

  it('claim rejects on overlap (dish1 11:30-12:30 inside lunch 10:30-13:00)', () => {
    rotaBindTelegramId('@bob', '99002');
    rotaRelease('d1-lunch-1', '99001');

    // Bob has dish1 (11:30-12:30), lunch (10:30-13:00) overlaps
    const result = rotaClaim('d1-lunch-1', '99002', 'Bob', '@bob');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('overlap');
  });

  it('claim succeeds when shifts do not overlap', () => {
    rotaRelease('d1-lunch-1', '99001');

    // Dave has dish3 (19:00-21:00), lunch (10:30-13:00) does not overlap
    const result = rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');
    expect(result).toEqual({ ok: true });
  });

  it('one-open limit prevents second release', () => {
    const rel1 = rotaRelease('d1-lunch-1', '99001');
    expect(rel1.ok).toBe(true);

    // Alice only has one shift (d1-lunch-1) so can't test second release
    // But Carol has one shift — release it, then try a second
    // Actually Carol only has one shift too. Let's add a second.
  });

  it('race: two people claim the same shift, only first wins', () => {
    rotaRelease('d1-lunch-1', '99001');

    const c1 = rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');
    expect(c1).toEqual({ ok: true });

    const c2 = rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.reason).toBe('already_taken');
  });
});

describe('one-open limit', () => {
  it('prevents releasing a second shift while one is open', () => {
    const payload = makePayload();
    payload.assignments.push({
      id: 'd2-lunch-1',
      day: 2,
      date: '2026-09-23',
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
    });
    rotaImport(payload);
    rotaBindTelegramId('@alice', '99001');

    const r1 = rotaRelease('d1-lunch-1', '99001');
    expect(r1.ok).toBe(true);

    const r2 = rotaRelease('d2-lunch-1', '99001');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('one_open');
  });
});

describe('fixture import via rota-commands path', () => {
  it('loads the full 133-row fixture', () => {
    const fixturePath = path.resolve(
      import.meta.dirname ?? '.',
      '../tests/fixtures/rota-import.json',
    );
    const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const result = rotaImport(payload);
    expect(result.inserted).toBe(133);

    const meta = rotaGetMeta();
    expect(meta).toBeDefined();
    expect(meta!.version).toContain('fixture');
  });
});
