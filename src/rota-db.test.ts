import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, _getDb } from './db.js';
import {
  rotaImport,
  rotaGetMeta,
  rotaGetByDate,
  rotaGetByDay,
  rotaGetByTelegramId,
  rotaGetByHandle,
  rotaBindTelegramId,
  rotaGetById,
  rotaGetOpenSlots,
  rotaGetAllAssignments,
  rotaRelease,
  rotaRerelease,
  rotaClaim,
  rotaGetCoveredByPerson,
  rotaLeaveEarly,
  rotaReset,
  rotaGetLog,
  rotaHasPinged,
  rotaRecordPing,
  rotaBuildStateResponse,
  rotaGetNoShiftReason,
  rotaGetNoShiftByName,
  type RotaImportPayload,
} from './rota-db.js';

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

function makePayload(
  overrides: Partial<RotaImportPayload> = {},
): RotaImportPayload {
  return {
    version: '2026-09-19T14:22:00Z-fixture',
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
        rota_key: '@bob',
        name: 'Bob',
        telegram: '@bob',
      },
      {
        id: 'd1-dish2-1',
        day: 1,
        date: '2026-09-22',
        block: 'dish2',
        block_label: 'Dish Team',
        slot: 1,
        start: '15:00',
        end: '17:00',
        hours: 2.0,
        weight: 2.0,
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
        id: 'd2-lunch-1',
        day: 2,
        date: '2026-09-23',
        block: 'lunch',
        block_label: 'Lunch Cooks',
        slot: 1,
        start: '10:30',
        end: '13:00',
        hours: 2.5,
        weight: 3.75,
        rota_key: '@eve',
        name: 'Eve',
        telegram: '@eve',
      },
      {
        id: 'd1-unfilled',
        day: 1,
        date: '2026-09-22',
        block: 'dish1',
        block_label: 'Dish Team',
        slot: 1,
        start: '11:30',
        end: '12:30',
        hours: 1.0,
        weight: 1.0,
        rota_key: null,
        name: null,
        telegram: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
});

// --- Import ---

describe('rotaImport', () => {
  it('imports assignments and stores meta', () => {
    const result = rotaImport(makePayload());
    expect(result.inserted).toBe(6);
    expect(result.replaced).toBe(false);

    const meta = rotaGetMeta();
    expect(meta).toBeDefined();
    expect(meta!.version).toBe('2026-09-19T14:22:00Z-fixture');
    expect(meta!.timezone).toBe('Europe/Berlin');
  });

  it('seeds current_person from original_person for filled slots', () => {
    rotaImport(makePayload());
    const a = rotaGetById('d1-lunch-1');
    expect(a).toBeDefined();
    expect(a!.current_person).toBe('@alice');
    expect(a!.current_name).toBe('Alice');
    expect(a!.current_telegram).toBe('@alice');
    expect(a!.state).toBe('assigned');
  });

  it('sets unfilled slots to state open with null person', () => {
    rotaImport(makePayload());
    const a = rotaGetById('d1-unfilled');
    expect(a).toBeDefined();
    expect(a!.state).toBe('open');
    expect(a!.original_person).toBeNull();
    expect(a!.current_person).toBeNull();
  });

  it('allows same-version re-import (replace)', () => {
    rotaImport(makePayload());
    const result = rotaImport(makePayload());
    expect(result.replaced).toBe(true);
    expect(result.inserted).toBe(6);
  });

  it('refuses different-version import', () => {
    rotaImport(makePayload());
    expect(() =>
      rotaImport(makePayload({ version: '2026-09-20T10:00:00Z-different' })),
    ).toThrow('Version mismatch');
  });

  it('refuses TEST- prefixed versions', () => {
    expect(() => rotaImport(makePayload({ version: 'TEST-dryrun' }))).toThrow(
      'TEST-',
    );
  });

  it('refuses duplicate assignment IDs', () => {
    const payload = makePayload();
    payload.assignments.push({ ...payload.assignments[0] });
    expect(() => rotaImport(payload)).toThrow('Duplicate assignment ID');
  });

  it('refuses unknown block references', () => {
    const payload = makePayload();
    payload.assignments[0].block = 'brunch';
    expect(() => rotaImport(payload)).toThrow('unknown block');
  });

  it('refuses is_test=true payloads', () => {
    expect(() =>
      rotaImport(makePayload({ is_test: true, version: 'LIVE-ok' })),
    ).toThrow('is_test=true');
  });

  it('allows is_test=false payloads', () => {
    const result = rotaImport(makePayload({ is_test: false }));
    expect(result.inserted).toBe(6);
  });

  it('refuses reimport when covers exist (freeze guard)', () => {
    rotaImport(makePayload());
    // Simulate a cover by inserting a log entry (real covers always log)
    const db = _getDb();
    db.prepare(
      "INSERT INTO rota_log (ts, assignment_id, from_person, to_person, reason) VALUES (datetime('now'), 'd1-lunch-1', 'tg:999', NULL, 'release')",
    ).run();

    expect(() => rotaImport(makePayload())).toThrow('mutation');
  });

  it('allows reimport with force flag when covers exist', () => {
    rotaImport(makePayload());
    const db = _getDb();
    db.prepare(
      "INSERT INTO rota_log (ts, assignment_id, from_person, to_person, reason) VALUES (datetime('now'), 'd1-lunch-1', 'tg:999', NULL, 'release')",
    ).run();

    const result = rotaImport(makePayload({ force: true }));
    expect(result.inserted).toBe(6);
    expect(result.replaced).toBe(true);
  });
});

// --- Queries ---

describe('queries', () => {
  beforeEach(() => {
    rotaImport(makePayload());
  });

  it('rotaGetByDate returns assignments for a date', () => {
    const rows = rotaGetByDate('2026-09-22');
    expect(rows.length).toBe(5);
  });

  it('rotaGetByDay returns assignments for a day number', () => {
    const rows = rotaGetByDay(1);
    expect(rows.length).toBe(5);
    const rows2 = rotaGetByDay(2);
    expect(rows2.length).toBe(1);
  });

  it('rotaGetByTelegramId returns empty when no ID bound yet', () => {
    const rows = rotaGetByTelegramId('12345');
    expect(rows.length).toBe(0);
  });

  it('rotaGetByHandle matches on original_telegram', () => {
    const rows = rotaGetByHandle('@alice');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('d1-lunch-1');
  });

  it('rotaGetOpenSlots returns only open state', () => {
    const open = rotaGetOpenSlots();
    expect(open.length).toBe(1);
    expect(open[0].id).toBe('d1-unfilled');
  });

  it('rotaGetAllAssignments returns all', () => {
    const all = rotaGetAllAssignments();
    expect(all.length).toBe(6);
  });
});

// --- Lazy binding ---

describe('lazy identity binding', () => {
  beforeEach(() => {
    rotaImport(makePayload());
  });

  it('binds telegram ID and enables lookup by ID', () => {
    const bound = rotaBindTelegramId('@alice', '99001');
    expect(bound).toBe(1);

    const rows = rotaGetByTelegramId('99001');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('d1-lunch-1');
  });

  it('returns 0 when handle not found', () => {
    const bound = rotaBindTelegramId('@nobody', '99999');
    expect(bound).toBe(0);
  });
});

// --- Release ---

describe('rotaRelease', () => {
  beforeEach(() => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
  });

  it('releases an assigned shift', () => {
    const result = rotaRelease('d1-lunch-1', '99001');
    expect(result).toEqual({ ok: true });

    const a = rotaGetById('d1-lunch-1')!;
    expect(a.state).toBe('open');
    expect(a.current_person).toBeNull();
  });

  it('fails for wrong person', () => {
    rotaBindTelegramId('@bob', '99002');
    const result = rotaRelease('d1-lunch-1', '99002');
    expect(result.ok).toBe(false);
  });

  it('fails for already-open shift', () => {
    rotaRelease('d1-lunch-1', '99001');
    const result = rotaRelease('d1-lunch-1', '99001');
    expect(result.ok).toBe(false);
  });

  it('enforces one-open limit', () => {
    rotaBindTelegramId('@bob', '99001');
    const payload = makePayload();
    payload.assignments.push({
      id: 'd2-dinner-1',
      day: 2,
      date: '2026-09-23',
      block: 'dinner',
      block_label: 'Dinner Cooks',
      slot: 1,
      start: '14:00',
      end: '18:00',
      hours: 4.0,
      weight: 4.0,
      rota_key: '@alice',
      name: 'Alice',
      telegram: '@alice',
    });
    rotaReset();
    rotaImport(payload);
    rotaBindTelegramId('@alice', '99001');

    const r1 = rotaRelease('d1-lunch-1', '99001');
    expect(r1.ok).toBe(true);

    const r2 = rotaRelease('d2-dinner-1', '99001');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('one_open');
  });

  it('creates a log entry', () => {
    rotaRelease('d1-lunch-1', '99001');
    const log = rotaGetLog();
    expect(log.length).toBe(1);
    expect(log[0].reason).toBe('cover_request');
  });
});

// --- Claim ---

describe('rotaClaim', () => {
  beforeEach(() => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    rotaBindTelegramId('@carol', '99003');
    rotaRelease('d1-lunch-1', '99001');
  });

  it('claims an open shift', () => {
    const result = rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');
    expect(result).toEqual({ ok: true });

    const a = rotaGetById('d1-lunch-1')!;
    expect(a.state).toBe('covered');
    expect(a.current_person).toBe('99003');
    expect(a.current_name).toBe('Carol');
  });

  it('fails on already-taken (race)', () => {
    rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');
    rotaBindTelegramId('@dave', '99004');
    const result = rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('already_taken');
  });

  it('rejects claim when claimer has overlapping shift (dish1 inside lunch)', () => {
    rotaReset();
    const payload = makePayload();
    payload.assignments = [
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
        rota_key: '@carol',
        name: 'Carol',
        telegram: '@carol',
      },
    ];
    rotaImport(payload);
    rotaBindTelegramId('@alice', '99001');
    rotaBindTelegramId('@carol', '99003');
    rotaRelease('d1-lunch-1', '99001');

    // Carol has dish1 (11:30-12:30) which overlaps lunch (10:30-13:00)
    const result = rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('overlap');
  });

  it('allows claim when shifts do not overlap', () => {
    rotaReset();
    const payload = makePayload();
    payload.assignments = [
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
        id: 'd1-dish3-1',
        day: 1,
        date: '2026-09-22',
        block: 'dish3',
        block_label: 'Dish Team',
        slot: 1,
        start: '19:00',
        end: '21:00',
        hours: 2.0,
        weight: 2.0,
        rota_key: '@carol',
        name: 'Carol',
        telegram: '@carol',
      },
    ];
    rotaImport(payload);
    rotaBindTelegramId('@alice', '99001');
    rotaBindTelegramId('@carol', '99003');
    rotaRelease('d1-lunch-1', '99001');

    // Carol has dish3 (19:00-21:00) which does NOT overlap lunch (10:30-13:00)
    const result = rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');
    expect(result).toEqual({ ok: true });
  });

  it('creates a log entry on claim', () => {
    rotaClaim('d1-lunch-1', '99003', 'Carol', '@carol');
    const log = rotaGetLog();
    const claimLog = log.find((l) => l.reason === 'claimed');
    expect(claimLog).toBeDefined();
    expect(claimLog!.to_person).toBe('99003');
  });
});

// --- Get covered by person ---

describe('rotaGetCoveredByPerson', () => {
  it('returns shifts covered by a given telegram ID', () => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    rotaRelease('d1-lunch-1', '99001');
    rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');

    const covered = rotaGetCoveredByPerson('99004');
    expect(covered).toHaveLength(1);
    expect(covered[0].id).toBe('d1-lunch-1');
    expect(covered[0].state).toBe('covered');
    expect(covered[0].current_person).toBe('99004');
  });

  it('returns empty when person has no covered shifts', () => {
    rotaImport(makePayload());
    expect(rotaGetCoveredByPerson('99999')).toHaveLength(0);
  });

  it('does not return assigned or open shifts', () => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    // Alice has assigned shifts but none covered
    const covered = rotaGetCoveredByPerson('99001');
    expect(covered).toHaveLength(0);
  });
});

// --- Rerelease ---

describe('rotaRerelease', () => {
  it('sets covered shift back to open', () => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    rotaRelease('d1-lunch-1', '99001');
    rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');

    const result = rotaRerelease('d1-lunch-1', '99004');
    expect(result).toEqual({ ok: true });

    const a = rotaGetById('d1-lunch-1')!;
    expect(a.state).toBe('open');
    expect(a.current_person).toBeNull();
    expect(a.current_name).toBeNull();
    expect(a.current_telegram).toBeNull();
  });

  it('rejects if not the current claimer', () => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    rotaRelease('d1-lunch-1', '99001');
    rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');

    const result = rotaRerelease('d1-lunch-1', '99001');
    expect(result).toEqual({ ok: false, reason: 'not_yours' });
  });

  it('rejects for non-existent assignment', () => {
    rotaImport(makePayload());
    const result = rotaRerelease('nonexistent', '99001');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects for assigned (not covered) shift', () => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    const result = rotaRerelease('d1-lunch-1', '99001');
    expect(result).toEqual({ ok: false, reason: 'not_yours' });
  });

  it('creates a log entry on rerelease', () => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    rotaRelease('d1-lunch-1', '99001');
    rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');
    rotaRerelease('d1-lunch-1', '99004');

    const log = rotaGetLog();
    const entry = log.find((l) => l.reason === 'rerelease');
    expect(entry).toBeDefined();
    expect(entry!.from_person).toBe('99004');
  });
});

// --- Leave early ---

describe('rotaLeaveEarly', () => {
  it('opens all future assigned shifts', () => {
    const payload = makePayload();
    // Add a past date assignment to alice
    payload.assignments.push({
      id: 'd0-lunch-1',
      day: 0,
      date: '2020-01-01',
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
    // Add another future assignment for alice
    payload.assignments.push({
      id: 'd2-dinner-1',
      day: 2,
      date: '2026-09-23',
      block: 'dinner',
      block_label: 'Dinner Cooks',
      slot: 1,
      start: '14:00',
      end: '18:00',
      hours: 4.0,
      weight: 4.0,
      rota_key: '@alice',
      name: 'Alice',
      telegram: '@alice',
    });
    rotaImport(payload);
    rotaBindTelegramId('@alice', '99001');

    const releasedIds = rotaLeaveEarly('99001');
    // d1-lunch-1 (future) and d2-dinner-1 (future) but NOT d0-lunch-1 (past)
    expect(releasedIds).toHaveLength(2);

    const log = rotaGetLog();
    expect(log.filter((l) => l.reason === 'leave_early').length).toBe(2);
  });
});

// --- Reset ---

describe('rotaReset', () => {
  it('clears all rota tables', () => {
    rotaImport(makePayload());
    expect(rotaGetMeta()).toBeDefined();

    rotaReset();
    expect(rotaGetMeta()).toBeUndefined();
    expect(rotaGetAllAssignments().length).toBe(0);
    expect(rotaGetLog().length).toBe(0);
  });

  it('allows different version import after reset', () => {
    rotaImport(makePayload());
    rotaReset();
    const result = rotaImport(
      makePayload({ version: '2026-09-20T10:00:00Z-v2' }),
    );
    expect(result.inserted).toBe(6);
    expect(rotaGetMeta()!.version).toBe('2026-09-20T10:00:00Z-v2');
  });
});

// --- Notifications ---

describe('notifications', () => {
  it('tracks ping state per assignment and type', () => {
    rotaImport(makePayload());

    expect(rotaHasPinged('d1-lunch-1', 'morning')).toBe(false);
    rotaRecordPing('d1-lunch-1', 'morning');
    expect(rotaHasPinged('d1-lunch-1', 'morning')).toBe(true);
    expect(rotaHasPinged('d1-lunch-1', 'reminder')).toBe(false);
  });

  it('survives re-record (INSERT OR IGNORE)', () => {
    rotaImport(makePayload());
    rotaRecordPing('d1-lunch-1', 'morning');
    expect(() => rotaRecordPing('d1-lunch-1', 'morning')).not.toThrow();
  });
});

// --- State response ---

describe('rotaBuildStateResponse', () => {
  it('returns undefined when no rota imported', () => {
    expect(rotaBuildStateResponse()).toBeUndefined();
  });

  it('returns full state shape', () => {
    rotaImport(makePayload());
    const state = rotaBuildStateResponse() as any;
    expect(state.version).toBe('2026-09-19T14:22:00Z-fixture');
    expect(state.as_of).toBeDefined();
    expect(state.assignments.length).toBe(6);
    expect(state.log).toEqual([]);

    const first = state.assignments[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('original_person');
    expect(first).toHaveProperty('current_person');
    expect(first).toHaveProperty('state');
  });
});

// --- Round-trip lifecycle ---

describe('full lifecycle: import → release → claim', () => {
  it('round-trips correctly', () => {
    rotaImport(makePayload());
    rotaBindTelegramId('@alice', '99001');
    rotaBindTelegramId('@dave', '99004');

    // Alice releases her lunch shift
    const rel = rotaRelease('d1-lunch-1', '99001');
    expect(rel.ok).toBe(true);

    // Dave claims it
    const claim = rotaClaim('d1-lunch-1', '99004', 'Dave', '@dave');
    expect(claim).toEqual({ ok: true });

    // Verify final state
    const a = rotaGetById('d1-lunch-1')!;
    expect(a.state).toBe('covered');
    expect(a.original_person).toBe('@alice');
    expect(a.current_person).toBe('99004');
    expect(a.current_name).toBe('Dave');

    // Two log entries: cover_request + claimed
    const log = rotaGetLog();
    expect(log.length).toBe(2);
    expect(log[0].reason).toBe('cover_request');
    expect(log[1].reason).toBe('claimed');
  });
});

// --- Contract fixture ---

describe('contract fixture import', () => {
  const fixturePath = path.resolve(
    import.meta.dirname ?? '.',
    '../tests/fixtures/rota-import.json',
  );

  it('imports the 133-row fixture successfully', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const payload = JSON.parse(raw);
    const result = rotaImport(payload);
    expect(result.inserted).toBe(133);
    expect(result.replaced).toBe(false);
  });

  it('fixture has correct structure', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const payload = JSON.parse(raw);
    rotaImport(payload);

    expect(rotaGetMeta()!.version).toBe('2026-09-19T14:22:00Z-fixture');
    expect(rotaGetAllAssignments().length).toBe(133);
    expect(rotaGetOpenSlots().length).toBe(4);

    // Day 1 has pinned crew on lunch + dish1
    const day1 = rotaGetByDay(1);
    const day1Lunch = day1.filter((a) => a.block === 'lunch');
    expect(day1Lunch.length).toBe(3);
    expect(day1Lunch.every((a) => a.state === 'assigned')).toBe(true);

    // Big night dish3 has weight = 4.0 (hours * 2)
    const d1Dish3 = day1.filter((a) => a.block === 'dish3');
    expect(d1Dish3.every((a) => a.weight === 4.0)).toBe(true);

    // Morning-after lunch has weight = 3.75 (2.5 * 1.5)
    const day2 = rotaGetByDay(2);
    const d2Lunch = day2.filter((a) => a.block === 'lunch');
    expect(d2Lunch.every((a) => a.weight === 3.75)).toBe(true);

    // Phone-number-only handle present
    const phoneHandles = rotaGetAllAssignments().filter(
      (a) => a.original_telegram && a.original_telegram.startsWith('+'),
    );
    expect(phoneHandles.length).toBeGreaterThan(0);

    // "(no telegram)" sanitized to null on import
    const noTelegram = rotaGetAllAssignments().filter(
      (a) => a.original_telegram === '(no telegram)',
    );
    expect(noTelegram.length).toBe(0);

    // First-name collision (two Alexanders)
    const alexanders = rotaGetAllAssignments().filter(
      (a) => a.original_name === 'Alexander',
    );
    expect(alexanders.length).toBeGreaterThanOrEqual(2);
  });
});

describe('no_shifts', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('imports and queries no_shifts entries', () => {
    const payload: RotaImportPayload = {
      version: 'LIVE-2026-09-20',
      timezone: 'Europe/Berlin',
      blocks: BLOCKS,
      big_nights: [],
      no_shifts: [
        { person_id: 'p1', name: 'Lukas K.', reason: 'Chef' },
        { person_id: 'p2', name: 'Mia', reason: 'Head of Buffet' },
      ],
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
          rota_key: 'p3',
          name: 'Alice',
          telegram: '@alice',
        },
      ],
    };

    const result = rotaImport(payload);
    expect(result.inserted).toBe(1);

    expect(rotaGetNoShiftReason('p1')).toBe('Chef');
    expect(rotaGetNoShiftReason('p2')).toBe('Head of Buffet');
    expect(rotaGetNoShiftReason('p999')).toBeNull();
  });

  it('rotaGetNoShiftByName is case-insensitive', () => {
    const payload: RotaImportPayload = {
      version: 'LIVE-2026-09-20',
      timezone: 'Europe/Berlin',
      blocks: BLOCKS,
      big_nights: [],
      no_shifts: [{ person_id: 'p1', name: 'Lukas K.', reason: 'Chef' }],
      assignments: [],
    };
    rotaImport(payload);

    const result = rotaGetNoShiftByName('lukas k.');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('Chef');
  });

  it('rotaReset clears no_shifts', () => {
    const payload: RotaImportPayload = {
      version: 'LIVE-2026-09-20',
      timezone: 'Europe/Berlin',
      blocks: BLOCKS,
      big_nights: [],
      no_shifts: [{ person_id: 'p1', name: 'Lukas K.', reason: 'Chef' }],
      assignments: [],
    };
    rotaImport(payload);
    expect(rotaGetNoShiftReason('p1')).toBe('Chef');

    rotaReset();
    expect(rotaGetNoShiftReason('p1')).toBeNull();
  });

  it('reimport replaces no_shifts', () => {
    const payload1: RotaImportPayload = {
      version: 'LIVE-2026-09-20',
      timezone: 'Europe/Berlin',
      blocks: BLOCKS,
      big_nights: [],
      no_shifts: [{ person_id: 'p1', name: 'Lukas K.', reason: 'Chef' }],
      assignments: [],
    };
    rotaImport(payload1);
    expect(rotaGetNoShiftReason('p1')).toBe('Chef');

    const payload2: RotaImportPayload = {
      version: 'LIVE-2026-09-20',
      timezone: 'Europe/Berlin',
      blocks: BLOCKS,
      big_nights: [],
      no_shifts: [{ person_id: 'p2', name: 'Mia', reason: 'Head of Buffet' }],
      assignments: [],
    };
    rotaImport(payload2);
    expect(rotaGetNoShiftReason('p1')).toBeNull();
    expect(rotaGetNoShiftReason('p2')).toBe('Head of Buffet');
  });
});
