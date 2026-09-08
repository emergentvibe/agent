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
  is_test: false,
  supersedes_all_previous: true,
  timezone: 'Europe/Berlin',
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
  assignments: [
    {
      person_id: 'a2',
      name: 'Simon',
      date: '2026-09-22',
      day: 1,
      block: 'lunch',
      start: '10:30',
      end: '13:00',
      hours: 2.5,
    },
    {
      person_id: 'a3',
      name: 'Jo',
      date: '2026-09-22',
      day: 1,
      block: 'lunch',
      start: '10:30',
      end: '13:00',
      hours: 2.5,
    },
    {
      person_id: 'a2',
      name: 'Simon',
      date: '2026-09-22',
      day: 1,
      block: 'dish1',
      start: '11:30',
      end: '12:30',
      hours: 1,
    },
  ],
  no_shifts: [
    { person_id: 'a1', name: 'Loz', reason: 'Head of Dishes' },
  ],
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
      expect(() => adaptRotaExport(testRota, 'v1')).toThrow('is_test=true');
    });

    it('maps blocks correctly', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      expect(result.blocks).toHaveLength(2);
      expect(result.blocks[0].key).toBe('lunch');
      expect(result.blocks[0].label).toBe('Lunch Cooks');
    });

    it('generates sequential slot numbers per block per day', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      const lunchSlots = result.assignments.filter(
        (a) => a.block === 'lunch',
      );
      expect(lunchSlots[0].slot).toBe(1);
      expect(lunchSlots[1].slot).toBe(2);
    });

    it('generates unique assignment IDs', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      const ids = result.assignments.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('derives block_label from blocks array', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      expect(result.assignments[0].block_label).toBe('Lunch Cooks');
    });

    it('uses person_id as rota_key', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      expect(result.assignments[0].rota_key).toBe('a2');
    });

    it('defaults weight to hours', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      expect(result.assignments[0].weight).toBe(2.5);
    });

    it('includes no_shifts entries', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      expect(result.no_shifts).toHaveLength(1);
      expect(result.no_shifts![0].person_id).toBe('a1');
      expect(result.no_shifts![0].reason).toBe('Head of Dishes');
    });

    it('cross-references telegram from attendee lookup', () => {
      const lookup = buildAttendeeLookup(ATTENDEES);
      const result = adaptRotaExport(ROTA, 'v1', lookup);
      const simonShift = result.assignments.find(
        (a) => a.rota_key === 'a2',
      );
      expect(simonShift!.telegram).toBe('@simon');
      const joShift = result.assignments.find((a) => a.rota_key === 'a3');
      expect(joShift!.telegram).toBeNull();
    });

    it('sets version and timezone from input', () => {
      const result = adaptRotaExport(ROTA, 'LIVE-2026-09-20');
      expect(result.version).toBe('LIVE-2026-09-20');
      expect(result.timezone).toBe('Europe/Berlin');
    });

    it('defaults big_nights to empty', () => {
      const result = adaptRotaExport(ROTA, 'v1');
      expect(result.big_nights).toEqual([]);
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
