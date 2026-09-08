import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  attendeeImport,
  attendeeCount,
  attendeeLookupByPersonId,
  attendeeLookupByHandle,
  attendeeLookupByTelegramDisplay,
} from './attendee-db.js';
import {
  rotaImport,
  rotaGetAllAssignments,
  rotaGetNoShiftReason,
  rotaExportTsv,
  rotaExportBackup,
} from './rota-db.js';
import {
  adaptAttendeeExport,
  adaptRotaExport,
  type SheetRotaExport,
} from './sheet-adapter.js';

const EXCHANGE_DIR = '/private/tmp/treeweek-exchange';
const ATTENDEE_PATH = path.join(EXCHANGE_DIR, 'attendees.sample.json');
const ROTA_PATH = path.join(EXCHANGE_DIR, 'rota.sample.json');

const hasFiles = fs.existsSync(ATTENDEE_PATH) && fs.existsSync(ROTA_PATH);

describe.skipIf(!hasFiles)('sheet-adapter integration (sample data)', () => {
  let attendeeRaw: any;
  let rotaRaw: SheetRotaExport;

  beforeEach(() => {
    _initTestDatabase();
    attendeeRaw = JSON.parse(fs.readFileSync(ATTENDEE_PATH, 'utf-8'));
    rotaRaw = JSON.parse(fs.readFileSync(ROTA_PATH, 'utf-8'));
  });

  describe('attendee import', () => {
    it('imports all 49 attendees via adapter', () => {
      const payload = adaptAttendeeExport(
        attendeeRaw.people,
        attendeeRaw.generated_at,
        attendeeRaw.event,
      );
      const result = attendeeImport(payload);
      expect(result.total).toBe(49);
      expect(result.created).toBe(49);
    });

    it('has correct role counts', () => {
      const payload = adaptAttendeeExport(
        attendeeRaw.people,
        attendeeRaw.generated_at,
        attendeeRaw.event,
      );
      attendeeImport(payload);
      const counts = attendeeCount();
      expect(counts.total).toBe(49);
      expect(counts.organizers).toBe(4);
      expect(counts.crew).toBe(12);
    });

    it('preserves person_id for cross-referencing', () => {
      const payload = adaptAttendeeExport(
        attendeeRaw.people,
        attendeeRaw.generated_at,
        attendeeRaw.event,
      );
      attendeeImport(payload);
      const first = attendeeRaw.people[0];
      const found = attendeeLookupByPersonId(first.person_id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe(first.name);
    });

    it('handles Nana unicode display name', () => {
      const payload = adaptAttendeeExport(
        attendeeRaw.people,
        attendeeRaw.generated_at,
        attendeeRaw.event,
      );
      attendeeImport(payload);
      const nana = attendeeRaw.people.find((p: any) => p.name === 'Nana');
      expect(nana).toBeDefined();
      const found = attendeeLookupByHandle(nana.telegram_username);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Nana');
    });

    it('resolves unique single-char display names (Bob=b, Jess=J)', () => {
      const payload = adaptAttendeeExport(
        attendeeRaw.people,
        attendeeRaw.generated_at,
        attendeeRaw.event,
      );
      attendeeImport(payload);
      const bob = attendeeLookupByTelegramDisplay('b');
      expect(bob).not.toBeNull();
      expect(bob!.name).toBe('Bob');
      const jess = attendeeLookupByTelegramDisplay('J');
      expect(jess).not.toBeNull();
      expect(jess!.name).toBe('Jess S.');
    });
  });

  describe('rota import', () => {
    it('rejects the sample rota (is_test=true)', () => {
      expect(() => adaptRotaExport(rotaRaw)).toThrow('is_test=true');
    });

    it('imports all 133 assignments with allowTest', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      const result = rotaImport(payload);
      expect(result.inserted).toBe(133);
    });

    it('has correct block structure', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      expect(payload.blocks).toHaveLength(5);
      const blockKeys = payload.blocks.map((b) => b.key).sort();
      expect(blockKeys).toEqual(['dinner', 'dish1', 'dish2', 'dish3', 'lunch']);
    });

    it('preserves sheet-issued assignment_ids', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      const all = rotaGetAllAssignments();
      expect(all[0].id).toMatch(/^\d{4}-\d{2}-\d{2}-\w+-\d+$/);
      const ids = new Set(all.map((a) => a.id));
      expect(ids.size).toBe(133);
    });

    it('extracts big_nights day numbers', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      expect(payload.big_nights).toEqual([1, 4, 6]);
    });

    it('preserves weight (not just hours)', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      const all = rotaGetAllAssignments();
      const weighted = all.filter((a) => a.weight !== a.hours);
      expect(weighted.length).toBeGreaterThan(0);
    });

    it('stores no_shifts entries', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      expect(rotaRaw.no_shifts.length).toBeGreaterThan(0);
      const reason = rotaGetNoShiftReason(rotaRaw.no_shifts[0].person_id);
      expect(reason).toBe(rotaRaw.no_shifts[0].reason);
    });

    it('covers all 7 days', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      const all = rotaGetAllAssignments();
      const days = new Set(all.map((a) => a.day));
      expect(days.size).toBe(7);
    });

    it('TSV export works with real data', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      const tsv = rotaExportTsv();
      expect(tsv).toBeDefined();
      const lines = tsv!.split('\n');
      expect(lines[0]).toMatch(/^exported_at\t/);
      expect(lines[1]).toMatch(/^assignment_id\t/);
      expect(lines.length).toBe(135);
    });

    it('backup export works with real data', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      const backup = rotaExportBackup() as any;
      expect(backup).toBeDefined();
      expect(backup.assignments).toHaveLength(133);
      expect(backup.assignments[0].assignment_id).toBeDefined();
      expect(backup.assignments[0].label).toBeDefined();
    });

    it('weight totals match expected (304.5 hours, 345.8 weighted)', () => {
      const payload = adaptRotaExport(rotaRaw, { allowTest: true });
      rotaImport(payload);
      const all = rotaGetAllAssignments();
      const totalHours = all.reduce((s, a) => s + a.hours, 0);
      const totalWeight = all.reduce((s, a) => s + a.weight, 0);
      expect(totalHours).toBeCloseTo(304.5, 1);
      expect(totalWeight).toBeCloseTo(345.75, 1);
    });
  });
});
