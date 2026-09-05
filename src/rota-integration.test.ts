import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './db.js';
import {
  rotaImport,
  rotaGetMeta,
  rotaGetByDate,
  rotaGetById,
  rotaGetByTelegramId,
  rotaGetByHandle,
  rotaBindTelegramId,
  rotaRelease,
  rotaClaim,
  rotaLeaveEarly,
  rotaGetLog,
  rotaGetOpenSlots,
  rotaReset,
  rotaHasPinged,
  rotaRecordPing,
  rotaBuildStateResponse,
  type RotaImportPayload,
} from './rota-db.js';
import { generateRotaPdf, parsePrintArgs } from './rota-print.js';
import { buildMorningAnnouncement } from './rota-reminders.js';

beforeEach(() => {
  _initTestDatabase();
});

function loadFixture(): RotaImportPayload {
  const fixturePath = path.resolve(
    import.meta.dirname ?? '.',
    '../tests/fixtures/rota-import.json',
  );
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

describe('rota integration: full lifecycle', () => {
  it('import → bind → release → claim → verify state', () => {
    const payload = loadFixture();
    const result = rotaImport(payload);
    expect(result.inserted).toBe(133);

    const meta = rotaGetMeta();
    expect(meta).toBeDefined();
    expect(meta!.version).toContain('fixture');

    // Verify unfilled slots are open
    const openSlots = rotaGetOpenSlots();
    expect(openSlots.length).toBe(4);

    // Verify a filled slot has correct state
    const pinned = rotaGetById('d1-lunch-1');
    expect(pinned).toBeDefined();
    expect(pinned!.state).toBe('assigned');
    expect(pinned!.original_person).not.toBeNull();
    expect(pinned!.current_person).toBe(pinned!.original_person);

    // Lazy bind: lookup by handle then bind ID
    const byHandle = rotaGetByHandle('@elliot_f');
    expect(byHandle.length).toBeGreaterThan(0);
    rotaBindTelegramId('@elliot_f', '88001');
    const byId = rotaGetByTelegramId('88001');
    expect(byId.length).toBe(byHandle.length);

    // Release a shift
    const myShifts = rotaGetByTelegramId('88001');
    const shiftToRelease = myShifts.find((s) => s.state === 'assigned');
    expect(shiftToRelease).toBeDefined();
    const releaseResult = rotaRelease(shiftToRelease!.id, '88001');
    expect(releaseResult.ok).toBe(true);

    // Verify it's open
    const released = rotaGetById(shiftToRelease!.id);
    expect(released!.state).toBe('open');
    expect(released!.current_person).toBeNull();
    expect(released!.original_person).not.toBeNull();

    // Another person claims it
    rotaBindTelegramId('@sharon_k', '88002');
    const claimResult = rotaClaim(
      shiftToRelease!.id,
      '88002',
      'Sharon',
      '@sharon_k',
    );
    expect(claimResult.ok).toBe(true);

    // Verify covered state
    const covered = rotaGetById(shiftToRelease!.id);
    expect(covered!.state).toBe('covered');
    expect(covered!.current_name).toBe('Sharon');
    expect(covered!.original_person).not.toBeNull();

    // Log entries
    const log = rotaGetLog();
    expect(log.length).toBeGreaterThanOrEqual(2);
    const reasons = log.map((l) => l.reason);
    expect(reasons).toContain('cover_request');
    expect(reasons).toContain('claimed');
  });

  it('same-version re-import replaces data', () => {
    const payload = loadFixture();
    rotaImport(payload);

    const openBefore = rotaGetOpenSlots().length;
    expect(openBefore).toBe(4);

    // Re-import same version
    const result = rotaImport(payload);
    expect(result.replaced).toBe(true);
    expect(result.inserted).toBe(133);

    const openAfter = rotaGetOpenSlots().length;
    expect(openAfter).toBe(4);
  });

  it('different-version import is refused', () => {
    const payload = loadFixture();
    rotaImport(payload);

    const payload2 = { ...payload, version: 'different-version' };
    expect(() => rotaImport(payload2)).toThrow();
  });

  it('reset then different version succeeds', () => {
    const payload = loadFixture();
    rotaImport(payload);
    rotaReset();

    expect(rotaGetMeta()).toBeUndefined();

    const payload2 = {
      ...payload,
      version: 'new-version-after-reset',
    };
    const result = rotaImport(payload2);
    expect(result.inserted).toBe(133);
  });

  it('leave-early opens all future shifts', () => {
    const payload = loadFixture();
    rotaImport(payload);

    // Bind a person who has multiple shifts
    rotaBindTelegramId('@elliot_f', '88001');
    const shifts = rotaGetByTelegramId('88001');
    const assignedCount = shifts.filter((s) => s.state === 'assigned').length;
    expect(assignedCount).toBeGreaterThan(0);

    const released = rotaLeaveEarly('88001');
    expect(released).toBeGreaterThan(0);

    // Verify log entries
    const log = rotaGetLog();
    const leaveEntries = log.filter((l) => l.reason === 'leave_early');
    expect(leaveEntries.length).toBe(released);
  });

  it('overlap check prevents double-booking', () => {
    const payload = loadFixture();
    rotaImport(payload);

    // Find someone on lunch (10:30-13:00) and release a dish1 (11:30-12:30) slot
    // dish1 overlaps lunch, so claiming dish1 when you have lunch should fail
    rotaBindTelegramId('@elliot_f', '88001');
    const shifts = rotaGetByTelegramId('88001');
    const lunchShift = shifts.find(
      (s) => s.block === 'lunch' && s.state === 'assigned',
    );

    if (lunchShift) {
      // Find a dish1 slot on the same day by a different person
      const sameDayAssignments = rotaGetByDate(lunchShift.date);
      const dish1 = sameDayAssignments.find(
        (a) =>
          a.block === 'dish1' &&
          a.original_telegram_id !== '88001' &&
          a.state === 'assigned',
      );

      if (dish1) {
        // Bind and release the dish1 person's shift
        if (dish1.original_telegram) {
          rotaBindTelegramId(dish1.original_telegram, '88099');
          rotaRelease(dish1.id, '88099');

          // Try to claim it with the lunch person — should fail (overlap)
          const claimResult = rotaClaim(
            dish1.id,
            '88001',
            'Elliot',
            '@elliot_f',
          );
          expect(claimResult.ok).toBe(false);
          if (!claimResult.ok) expect(claimResult.reason).toBe('overlap');
        }
      }
    }
  });

  it('notification dedup persists across queries', () => {
    const payload = loadFixture();
    rotaImport(payload);

    expect(rotaHasPinged('d1-lunch-1', 'dm_88001')).toBe(false);
    rotaRecordPing('d1-lunch-1', 'dm_88001');
    expect(rotaHasPinged('d1-lunch-1', 'dm_88001')).toBe(true);
    expect(rotaHasPinged('d1-lunch-1', 'dm_88002')).toBe(false);
  });

  it('state response has correct shape', () => {
    const payload = loadFixture();
    rotaImport(payload);

    const state = rotaBuildStateResponse() as any;
    expect(state).toBeDefined();
    expect(state.version).toContain('fixture');
    expect(state.assignments).toHaveLength(133);
    expect(state.assignments[0]).toHaveProperty('id');
    expect(state.assignments[0]).toHaveProperty('state');
    expect(state.assignments[0]).toHaveProperty('original_person');
    expect(state.assignments[0]).toHaveProperty('current_person');
  });
});

describe('rota integration: PDF generation', () => {
  it('generates PDF from fixture data', async () => {
    const payload = loadFixture();
    rotaImport(payload);

    const result = await generateRotaPdf('2026-09-22');
    expect('buffer' in result).toBe(true);
    if ('buffer' in result) {
      expect(result.buffer.length).toBeGreaterThan(500);
      expect(result.buffer.slice(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('parsePrintArgs handles all cases', () => {
    expect(parsePrintArgs('/admin-rota-print today')).toBe(
      new Date().toISOString().slice(0, 10),
    );
    expect(parsePrintArgs('/admin-rota-print 2026-09-25')).toBe('2026-09-25');
  });
});

describe('rota integration: morning announcement', () => {
  it('builds announcement from fixture data', () => {
    const payload = loadFixture();
    rotaImport(payload);

    const assignments = rotaGetByDate('2026-09-22');
    const text = buildMorningAnnouncement('2026-09-22', assignments);
    expect(text).toContain('Kitchen shifts for');
    expect(text.length).toBeGreaterThan(100);

    // Should have open slots mentioned
    const openCount = assignments.filter((a) => a.state === 'open').length;
    if (openCount > 0) {
      expect(text).toContain('open slot');
    }
  });
});

describe('rota integration: assignments never reach Mem0', () => {
  it('no assignment data in state response metadata', () => {
    const payload = loadFixture();
    rotaImport(payload);

    const state = rotaBuildStateResponse() as any;
    const stateStr = JSON.stringify(state);

    // Assignments should not contain Mem0-related keys
    expect(stateStr).not.toContain('mem0');
    expect(stateStr).not.toContain('memory_id');
    expect(stateStr).not.toContain('namespace');
  });
});
