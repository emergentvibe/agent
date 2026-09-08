import { describe, expect, it } from 'vitest';

import {
  adaptAttendeeExport,
  adaptRotaExport,
  buildAttendeeLookup,
  type SheetAttendee,
  type SheetRotaExport,
} from './sheet-adapter.js';

const ATTENDEES: SheetAttendee[] = [
  {
    person_id: 'a1',
    name: 'Loz',
    telegram_username: '@lozarino',
    telegram_display: 'Loz',
    phone: null,
    role: 'crew',
    title: 'Head of Dishes',
    is_admin: false,
  },
  {
    person_id: 'a2',
    name: 'Simon',
    telegram_username: '@simon',
    telegram_display: 'Si',
    phone: '+491111',
    role: 'organiser',
    title: null,
    is_admin: true,
  },
  {
    person_id: 'a3',
    name: 'Jo',
    telegram_username: null,
    telegram_display: 'J',
    phone: '+492222',
    role: 'attendee',
    title: null,
    is_admin: false,
  },
];

const ROTA: SheetRotaExport = {
  export: 'rota',
  schema_version: '1.1',
  generated_at: '2026-09-20T14:00:00+02:00',
  is_test: false,
  supersedes_all_previous: true,
  event: 'TREEWEEK III',
  timezone: 'Europe/Berlin',
  days: [
    { day: 1, date: '2026-09-22' },
    { day: 2, date: '2026-09-23' },
  ],
  blocks: [
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
      hours: 1,
      slots: 4,
    },
  ],
  big_nights: [{ day: 1, date: '2026-09-22', type: 'PARTY' }],
  weighting: {
    rule: 'weight = hours, except big night dish3 x2.0',
    big_night_multiplier: 2.0,
    morning_after_multiplier: 1.5,
  },
  counts: { assignments: 4, people: 3, no_shifts: 1 },
  assignments: [
    {
      assignment_id: '2026-09-22-lunch-1',
      slot: 1,
      state: 'assigned',
      original_person_id: 'a2',
      person_id: 'a2',
      name: 'Simon',
      telegram_username: '@simon',
      telegram_display: 'Si',
      date: '2026-09-22',
      day: 1,
      block: 'lunch',
      label: 'Lunch Cooks',
      start: '10:30',
      end: '13:00',
      hours: 2.5,
      weight: 2.5,
    },
    {
      assignment_id: '2026-09-22-lunch-2',
      slot: 2,
      state: 'assigned',
      original_person_id: 'a3',
      person_id: 'a3',
      name: 'Jo',
      telegram_username: null,
      telegram_display: 'J',
      date: '2026-09-22',
      day: 1,
      block: 'lunch',
      label: 'Lunch Cooks',
      start: '10:30',
      end: '13:00',
      hours: 2.5,
      weight: 2.5,
    },
    {
      assignment_id: '2026-09-22-lunch-3',
      slot: 3,
      state: 'open',
      original_person_id: null,
      person_id: null,
      name: null,
      telegram_username: null,
      telegram_display: null,
      date: '2026-09-22',
      day: 1,
      block: 'lunch',
      label: 'Lunch Cooks',
      start: '10:30',
      end: '13:00',
      hours: 2.5,
      weight: 2.5,
    },
    {
      assignment_id: '2026-09-22-dish1-1',
      slot: 1,
      state: 'assigned',
      original_person_id: 'a2',
      person_id: 'a2',
      name: 'Simon',
      telegram_username: '@simon',
      telegram_display: 'Si',
      date: '2026-09-22',
      day: 1,
      block: 'dish1',
      label: 'Dish Team',
      start: '11:30',
      end: '12:30',
      hours: 1,
      weight: 1,
    },
  ],
  no_shifts: [{ person_id: 'a1', name: 'Loz', reason: 'Head of Dishes' }],
};

describe('sheet-adapter', () => {
  describe('adaptAttendeeExport', () => {
    it('maps all fields correctly', () => {
      const result = adaptAttendeeExport(ATTENDEES, 'v1', 'Treeweek III');
      expect(result.version).toBe('v1');
      expect(result.event).toBe('Treeweek III');
      expect(result.attendees).toHaveLength(3);
    });

    it('normalizes organiser to organizer', () => {
      const result = adaptAttendeeExport(ATTENDEES, 'v1', 'Treeweek III');
      const simon = result.attendees.find((a) => a.name === 'Simon');
      expect(simon!.role).toBe('organizer');
    });

    it('preserves person_id', () => {
      const result = adaptAttendeeExport(ATTENDEES, 'v1', 'Treeweek III');
      const loz = result.attendees.find((a) => a.name === 'Loz');
      expect(loz!.person_id).toBe('a1');
    });

    it('preserves title for crew', () => {
      const result = adaptAttendeeExport(ATTENDEES, 'v1', 'Treeweek III');
      const loz = result.attendees.find((a) => a.name === 'Loz');
      expect(loz!.title).toBe('Head of Dishes');
    });

    it('maps telegram_username correctly', () => {
      const result = adaptAttendeeExport(ATTENDEES, 'v1', 'Treeweek III');
      const loz = result.attendees.find((a) => a.name === 'Loz');
      expect(loz!.telegram_username).toBe('@lozarino');
      const jo = result.attendees.find((a) => a.name === 'Jo');
      expect(jo!.telegram_username).toBeNull();
    });
  });

  describe('adaptRotaExport', () => {
    it('rejects test exports', () => {
      const testRota = { ...ROTA, is_test: true };
      expect(() => adaptRotaExport(testRota)).toThrow('is_test=true');
    });

    it('maps blocks correctly', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.blocks).toHaveLength(2);
      expect(result.blocks[0].key).toBe('lunch');
      expect(result.blocks[0].label).toBe('Lunch Cooks');
    });

    it('adopts sheet-issued assignment_id as id', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.assignments[0].id).toBe('2026-09-22-lunch-1');
      expect(result.assignments[3].id).toBe('2026-09-22-dish1-1');
    });

    it('adopts sheet-issued slot numbers', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.assignments[0].slot).toBe(1);
      expect(result.assignments[1].slot).toBe(2);
      expect(result.assignments[2].slot).toBe(3);
    });

    it('maps label to block_label', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.assignments[0].block_label).toBe('Lunch Cooks');
    });

    it('uses person_id as rota_key for assigned slots', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.assignments[0].rota_key).toBe('a2');
    });

    it('sets rota_key to null for open slots', () => {
      const result = adaptRotaExport(ROTA);
      const open = result.assignments.find(
        (a) => a.id === '2026-09-22-lunch-3',
      );
      expect(open!.rota_key).toBeNull();
      expect(open!.name).toBeNull();
    });

    it('preserves weight from sheet (not defaulting to hours)', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.assignments[0].weight).toBe(2.5);
      expect(result.assignments[0].hours).toBe(2.5);
    });

    it('includes no_shifts entries', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.no_shifts).toHaveLength(1);
      expect(result.no_shifts![0].person_id).toBe('a1');
      expect(result.no_shifts![0].reason).toBe('Head of Dishes');
    });

    it('extracts big_nights day numbers from objects', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.big_nights).toEqual([1]);
    });

    it('uses generated_at as version', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.version).toBe('2026-09-20T14:00:00+02:00');
      expect(result.timezone).toBe('Europe/Berlin');
    });

    it('sets is_test to false on output', () => {
      const result = adaptRotaExport(ROTA);
      expect(result.is_test).toBe(false);
    });

    it('passes telegram_username through for assigned slots', () => {
      const result = adaptRotaExport(ROTA);
      const simon = result.assignments.find(
        (a) => a.id === '2026-09-22-lunch-1',
      );
      expect(simon!.telegram).toBe('@simon');
    });
  });

  describe('buildAttendeeLookup', () => {
    it('keys by person_id', () => {
      const lookup = buildAttendeeLookup(ATTENDEES);
      expect(lookup.size).toBe(3);
      expect(lookup.get('a1')!.name).toBe('Loz');
      expect(lookup.get('a2')!.name).toBe('Simon');
    });
  });
});
