import { describe, expect, it, beforeEach } from 'vitest';

import {
  attendeeClear,
  attendeeCheckIn,
  attendeeCount,
  attendeeGetAll,
  attendeeGetByRole,
  attendeeGetCheckedIn,
  attendeeGetNotCheckedIn,
  attendeeImport,
  attendeeLookupByHandle,
  attendeeLookupByName,
  attendeeLookupByPersonId,
  attendeeLookupByPhone,
  attendeeLookupByTelegramDisplay,
  attendeeLookupByTelegramId,
  isAttendeeAdmin,
  type AttendeeImportPayload,
} from './attendee-db.js';
import { _initTestDatabase } from './db.js';

const PAYLOAD: AttendeeImportPayload = {
  version: '1',
  event: 'Test Event',
  attendees: [
    { name: 'Alice', telegram: '@alice', phone: '+491111', role: 'crew' },
    { name: 'Bob Smith', telegram: '@bob', role: 'attendee' },
    { name: 'Charlie', phone: '+492222', role: 'organizer' },
    { name: 'Diana', role: 'attendee' },
  ],
};

describe('attendee-db', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  describe('import', () => {
    it('imports attendees', () => {
      const result = attendeeImport(PAYLOAD);
      expect(result.total).toBe(4);
      expect(result.created).toBe(4);
      expect(result.updated).toBe(0);
    });

    it('upserts on re-import', () => {
      attendeeImport(PAYLOAD);
      const result = attendeeImport({
        ...PAYLOAD,
        attendees: [
          { name: 'Alice', telegram: '@alice_new', role: 'organizer' },
          { name: 'Eve', role: 'attendee' },
        ],
      });
      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);

      const alice = attendeeLookupByHandle('@alice_new');
      expect(alice).not.toBeNull();
      expect(alice!.role).toBe('organizer');
    });

    it('skips entries with no name', () => {
      const result = attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          { name: '', role: 'attendee' },
          { name: 'Valid', role: 'attendee' },
        ],
      });
      expect(result.created).toBe(1);
    });

    it('imports telegram_handle field (new format)', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          {
            name: 'NewFormat',
            telegram_handle: '@newformat',
            role: 'attendee',
          },
        ],
      });
      const found = attendeeLookupByHandle('@newformat');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('NewFormat');
    });

    it('imports telegram_display field', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          {
            name: 'DisplayTest',
            telegram_display: 'DisplayName',
            role: 'attendee',
          },
        ],
      });
      const found = attendeeLookupByTelegramDisplay('DisplayName');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('DisplayTest');
    });

    it('prefers telegram_handle over legacy telegram field', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          {
            name: 'Both',
            telegram: '@legacy',
            telegram_handle: '@preferred',
            role: 'attendee',
          },
        ],
      });
      expect(attendeeLookupByHandle('@preferred')).not.toBeNull();
      expect(attendeeLookupByHandle('@legacy')).toBeNull();
    });

    it('upsert preserves existing telegram_display', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          {
            name: 'Keeper',
            telegram_display: 'OriginalDisplay',
            role: 'attendee',
          },
        ],
      });
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [{ name: 'Keeper', telegram: '@keeper', role: 'crew' }],
      });
      const found = attendeeLookupByTelegramDisplay('OriginalDisplay');
      expect(found).not.toBeNull();
      expect(found!.role).toBe('crew');
    });
  });

  describe('lookup', () => {
    beforeEach(() => {
      attendeeImport(PAYLOAD);
    });

    it('by handle', () => {
      const a = attendeeLookupByHandle('@alice');
      expect(a).not.toBeNull();
      expect(a!.name).toBe('Alice');
      expect(a!.role).toBe('crew');
    });

    it('by handle is case-insensitive', () => {
      const a = attendeeLookupByHandle('@ALICE');
      expect(a).not.toBeNull();
    });

    it('by handle adds @ if missing', () => {
      const a = attendeeLookupByHandle('alice');
      expect(a).not.toBeNull();
    });

    it('by phone', () => {
      const a = attendeeLookupByPhone('+492222');
      expect(a).not.toBeNull();
      expect(a!.name).toBe('Charlie');
    });

    it('by telegram_id after check-in', () => {
      const alice = attendeeLookupByHandle('@alice');
      attendeeCheckIn(alice!.id, 'tg:99999');
      const found = attendeeLookupByTelegramId('tg:99999');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Alice');
    });

    it('by name exact match', () => {
      const results = attendeeLookupByName('Bob Smith');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Bob Smith');
    });

    it('by name case-insensitive', () => {
      const results = attendeeLookupByName('bob smith');
      expect(results.length).toBe(1);
    });

    it('by name fuzzy first-name match', () => {
      const results = attendeeLookupByName('Bob');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Bob Smith');
    });

    it('returns empty for unknown name', () => {
      const results = attendeeLookupByName('Nobody');
      expect(results.length).toBe(0);
    });

    it('returns multiple for ambiguous first name', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          { name: 'Alex Johnson', role: 'attendee' },
          { name: 'Alex Rivera', role: 'attendee' },
        ],
      });
      const results = attendeeLookupByName('Alex');
      expect(results.length).toBe(2);
    });

    it('matches Telegram concat (first_name + last_name) against full name', () => {
      const results = attendeeLookupByName('Bob Smith');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Bob Smith');
    });

    it('does not match partial last name', () => {
      const results = attendeeLookupByName('Smith');
      expect(results.length).toBe(0);
    });

    it('by telegram_display', () => {
      attendeeClear();
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          { name: 'Frederick F.', telegram_display: 'Fred', role: 'attendee' },
        ],
      });
      const found = attendeeLookupByTelegramDisplay('Fred');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Frederick F.');
    });

    it('by telegram_display is case-insensitive', () => {
      attendeeClear();
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          { name: 'Frederick F.', telegram_display: 'Fred', role: 'attendee' },
        ],
      });
      expect(attendeeLookupByTelegramDisplay('fred')).not.toBeNull();
      expect(attendeeLookupByTelegramDisplay('FRED')).not.toBeNull();
    });

    it('by telegram_display returns null for empty string', () => {
      expect(attendeeLookupByTelegramDisplay('')).toBeNull();
      expect(attendeeLookupByTelegramDisplay('  ')).toBeNull();
    });

    it('by telegram_display returns null for no match', () => {
      attendeeImport(PAYLOAD);
      expect(attendeeLookupByTelegramDisplay('Nobody')).toBeNull();
    });

    it('by telegram_display returns null when multiple attendees share the name', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          { name: 'Person A', telegram_display: 'J', role: 'attendee' },
          { name: 'Person B', telegram_display: 'J', role: 'attendee' },
        ],
      });
      expect(attendeeLookupByTelegramDisplay('J')).toBeNull();
    });

    it('by telegram_display normalizes unicode (NFC)', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          {
            name: 'Nana',
            telegram_display: 'Nana ☉',
            role: 'attendee',
          },
        ],
      });
      expect(attendeeLookupByTelegramDisplay('Nana ☉')).not.toBeNull();
      expect(attendeeLookupByTelegramDisplay('nana ☉')).not.toBeNull();
    });
  });

  describe('check-in', () => {
    beforeEach(() => {
      attendeeImport(PAYLOAD);
    });

    it('marks attendee as checked in', () => {
      const alice = attendeeLookupByHandle('@alice')!;
      expect(alice.checked_in).toBe(false);

      attendeeCheckIn(alice.id, 'tg:12345');

      const updated = attendeeLookupByTelegramId('tg:12345')!;
      expect(updated.checked_in).toBe(true);
      expect(updated.checked_in_at).toBeTruthy();
      expect(updated.telegram_id).toBe('tg:12345');
    });
  });

  describe('queries', () => {
    beforeEach(() => {
      attendeeImport(PAYLOAD);
      const alice = attendeeLookupByHandle('@alice')!;
      attendeeCheckIn(alice.id, 'tg:111');
    });

    it('getAll returns all attendees', () => {
      expect(attendeeGetAll().length).toBe(4);
    });

    it('getCheckedIn returns only checked-in', () => {
      const result = attendeeGetCheckedIn();
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Alice');
    });

    it('getNotCheckedIn returns unchecked', () => {
      expect(attendeeGetNotCheckedIn().length).toBe(3);
    });

    it('getByRole filters correctly', () => {
      expect(attendeeGetByRole('crew').length).toBe(1);
      expect(attendeeGetByRole('organizer').length).toBe(1);
      expect(attendeeGetByRole('attendee').length).toBe(2);
    });

    it('attendeeCount returns correct counts', () => {
      const c = attendeeCount();
      expect(c.total).toBe(4);
      expect(c.checked_in).toBe(1);
      expect(c.crew).toBe(2); // crew + organizer
      expect(c.organizers).toBe(1);
    });
  });

  describe('isAttendeeAdmin', () => {
    it('returns true for checked-in organizer', () => {
      attendeeImport(PAYLOAD);
      const charlie = attendeeLookupByPhone('+492222')!;
      attendeeCheckIn(charlie.id, 'tg:333');
      expect(isAttendeeAdmin('tg:333')).toBe(true);
    });

    it('returns false for non-organizer', () => {
      attendeeImport(PAYLOAD);
      const alice = attendeeLookupByHandle('@alice')!;
      attendeeCheckIn(alice.id, 'tg:111');
      expect(isAttendeeAdmin('tg:111')).toBe(false);
    });

    it('returns false for unchecked-in organizer', () => {
      attendeeImport(PAYLOAD);
      expect(isAttendeeAdmin('tg:unknown')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all attendees', () => {
      attendeeImport(PAYLOAD);
      expect(attendeeGetAll().length).toBe(4);
      attendeeClear();
      expect(attendeeGetAll().length).toBe(0);
    });
  });

  describe('person_id and title', () => {
    it('stores and retrieves person_id', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          { name: 'Loz', person_id: 'abc123', telegram: '@loz', role: 'crew' },
        ],
      });
      const found = attendeeLookupByPersonId('abc123');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Loz');
    });

    it('stores and retrieves title', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          {
            name: 'Loz',
            person_id: 'abc123',
            role: 'crew',
            title: 'Head of Dishes',
          },
        ],
      });
      const found = attendeeLookupByPersonId('abc123');
      expect(found!.title).toBe('Head of Dishes');
    });

    it('normalizes organiser to organizer', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [{ name: 'Simon', person_id: 's1', role: 'organiser' }],
      });
      const found = attendeeLookupByPersonId('s1');
      expect(found!.role).toBe('organizer');
    });

    it('accepts telegram_username field', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [
          { name: 'Jo', telegram_username: '@jo_tg', role: 'attendee' },
        ],
      });
      const found = attendeeLookupByHandle('@jo_tg');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Jo');
    });

    it('upsert preserves person_id on re-import', () => {
      attendeeImport({
        version: '1',
        event: 'Test',
        attendees: [{ name: 'Loz', person_id: 'abc123', role: 'crew' }],
      });
      attendeeImport({
        version: '2',
        event: 'Test',
        attendees: [{ name: 'Loz', telegram: '@lozarino', role: 'crew' }],
      });
      const found = attendeeLookupByHandle('@lozarino');
      expect(found!.person_id).toBe('abc123');
    });
  });
});
