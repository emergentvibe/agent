import { describe, expect, it, beforeEach } from 'vitest';

import {
  handleAdminCommand,
  isDegraded,
  isSilenced,
  setDegraded,
  setSilenced,
  rotaImportState,
  isRotaImportPending,
  clearRotaImportState,
  attendeeImportState,
  isAttendeeImportPending,
  clearAttendeeImportState,
  handleAttendeeImportFile,
} from './admin-commands.js';
import {
  _initTestDatabase,
  setRegisteredGroup,
  storePurchase,
  upsertTopic,
} from './db.js';
import { rotaImport } from './rota-db.js';

const ADMIN_ID = '123456';

describe('admin-commands', () => {
  beforeEach(() => {
    _initTestDatabase();
    setSilenced(false);
    setDegraded(false);
    clearRotaImportState();
    clearAttendeeImportState();
  });

  it('ignores commands from non-admin', async () => {
    const result = await handleAdminCommand(
      '/admin-silence',
      'other-user',
      ADMIN_ID,
    );
    expect(result.handled).toBe(false);
    expect(isSilenced()).toBe(false);
  });

  it('ignores commands when no admin configured and no organizer role', async () => {
    const result = await handleAdminCommand(
      '/admin-silence',
      ADMIN_ID,
      undefined,
    );
    expect(result.handled).toBe(false);
  });

  it('allows organizer to use admin commands after check-in', async () => {
    // Import an organizer
    handleAttendeeImportFile(
      JSON.stringify({
        version: '1',
        event: 'Test',
        attendees: [{ name: 'Simon', telegram: '@simon', role: 'organizer' }],
      }),
    );
    // Check them in (binds telegram_id)
    const { attendeeCheckIn, attendeeLookupByHandle } =
      await import('./attendee-db.js');
    const simon = attendeeLookupByHandle('@simon')!;
    attendeeCheckIn(simon.id, 'simon-tg-id');

    // Now simon can use admin commands even without being in ADMIN_TELEGRAM_ID
    const result = await handleAdminCommand(
      '/admin-status',
      'simon-tg-id',
      ADMIN_ID, // simon is NOT in this list
    );
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Status Report');
  });

  it('/admin-silence enables silence', async () => {
    const result = await handleAdminCommand(
      '/admin-silence',
      ADMIN_ID,
      ADMIN_ID,
    );
    expect(result.handled).toBe(true);
    expect(result.response).toContain('silenced');
    expect(isSilenced()).toBe(true);
  });

  it('/admin-silence off disables silence', async () => {
    await handleAdminCommand('/admin-silence', ADMIN_ID, ADMIN_ID);
    expect(isSilenced()).toBe(true);

    const result = await handleAdminCommand(
      '/admin-silence off',
      ADMIN_ID,
      ADMIN_ID,
    );
    expect(result.handled).toBe(true);
    expect(result.response).toContain('resumed');
    expect(isSilenced()).toBe(false);
  });

  it('/admin-status returns a report', async () => {
    const result = await handleAdminCommand(
      '/admin-status',
      ADMIN_ID,
      ADMIN_ID,
    );
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Status Report');
    expect(result.response).toContain('Uptime');
    expect(result.response).toContain('Mode: normal');
  });

  it('/admin-status reflects silence state', async () => {
    await handleAdminCommand('/admin-silence', ADMIN_ID, ADMIN_ID);
    const result = await handleAdminCommand(
      '/admin-status',
      ADMIN_ID,
      ADMIN_ID,
    );
    expect(result.response).toContain('Mode: SILENCED');
  });

  it('/admin-status reflects degraded state', async () => {
    setDegraded(true);
    const result = await handleAdminCommand(
      '/admin-status',
      ADMIN_ID,
      ADMIN_ID,
    );
    expect(result.response).toContain('Mode: DEGRADED');
  });

  it('non-admin commands pass through', async () => {
    const result = await handleAdminCommand('/hello', ADMIN_ID, ADMIN_ID);
    expect(result.handled).toBe(false);
  });

  describe('/admin-topics', () => {
    it('shows no main groups when none registered', async () => {
      const result = await handleAdminCommand(
        '/admin-topics',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No main groups');
    });

    it('lists discovered topics with extraction status', async () => {
      setRegisteredGroup('tg:123', {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Bot',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      });
      upsertTopic('tg:123', 2, 'Kitchen');
      upsertTopic('tg:123', 3, 'Events');

      const result = await handleAdminCommand(
        '/admin-topics',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Kitchen');
      expect(result.response).toContain('Events');
      expect(result.response).toContain('extraction: OFF');
    });
  });

  describe('/admin-extract-on and /admin-extract-off', () => {
    beforeEach(() => {
      setRegisteredGroup('tg:123', {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Bot',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      });
      upsertTopic('tg:123', 2, 'Kitchen');
    });

    it('enables extraction for a topic by name', async () => {
      const result = await handleAdminCommand(
        '/admin-extract-on Kitchen',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('ON');
      expect(result.response).toContain('Kitchen');
    });

    it('disables extraction for a topic by id', async () => {
      await handleAdminCommand('/admin-extract-on 2', ADMIN_ID, ADMIN_ID);
      const result = await handleAdminCommand(
        '/admin-extract-off 2',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('OFF');
    });

    it('returns not found for unknown topic', async () => {
      const result = await handleAdminCommand(
        '/admin-extract-on Sauna',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.response).toContain('not found');
    });
  });

  describe('/admin-tab', () => {
    it('shows all purchase totals', async () => {
      storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
      storePurchase('tg:123', 'user1', 'Alice', 'wine', 5);
      storePurchase('tg:123', 'user2', 'Bob', 'burger', 5);

      const result = await handleAdminCommand('/admin-tab', ADMIN_ID, ADMIN_ID);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Alice');
      expect(result.response).toContain('€8.00');
      expect(result.response).toContain('Bob');
      expect(result.response).toContain('€5.00');
    });

    it('shows user-specific purchases', async () => {
      storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
      storePurchase('tg:123', 'user1', 'Alice', 'wine', 5);

      const result = await handleAdminCommand(
        '/admin-tab user1',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('beer');
      expect(result.response).toContain('wine');
      expect(result.response).toContain('€8.00');
    });

    it('exports CSV file with purchases and totals', async () => {
      storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);

      const result = await handleAdminCommand(
        '/admin-tab export',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.file).toBeDefined();
      const csv = result.file!.buffer.toString('utf-8');
      expect(csv).toContain('user_id,user_name,item,price');
      expect(csv).toContain('user1,Alice,beer,3');
      expect(csv).toContain('--- TOTALS ---');
      expect(csv).toContain('Alice,3.00');
      expect(result.file!.filename).toMatch(
        /^purchases-\d{4}-\d{2}-\d{2}\.csv$/,
      );
    });

    it('handles no purchases', async () => {
      const result = await handleAdminCommand('/admin-tab', ADMIN_ID, ADMIN_ID);
      expect(result.response).toContain('No purchases');
    });
  });

  describe('/admin-rota-import', () => {
    it('sets pending state and replies with instructions', async () => {
      const result = await handleAdminCommand(
        '/admin-rota-import',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Send me the rota JSON file');
      expect(rotaImportState.pending).toBe(true);
      expect(rotaImportState.sender).toBe(ADMIN_ID);
    });

    it('shows current version when rota exists', async () => {
      rotaImport({
        version: 'v1-test',
        timezone: 'Europe/Berlin',
        blocks: [
          {
            key: 'lunch',
            label: 'Lunch',
            start: '10:30',
            end: '13:00',
            hours: 2.5,
            slots: 3,
          },
        ],
        big_nights: [],
        assignments: [],
      });

      const result = await handleAdminCommand(
        '/admin-rota-import',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.response).toContain('v1-test');
      expect(result.response).toContain('replaced');
    });

    it('isRotaImportPending returns true for correct sender', async () => {
      await handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      expect(isRotaImportPending(ADMIN_ID)).toBe(true);
    });

    it('isRotaImportPending returns false for wrong sender', async () => {
      await handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      expect(isRotaImportPending('other-user')).toBe(false);
    });

    it('isRotaImportPending returns false after expiry', async () => {
      await handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      rotaImportState.expiresAt = Date.now() - 1000;
      expect(isRotaImportPending(ADMIN_ID)).toBe(false);
    });

    it('clearRotaImportState resets everything', async () => {
      await handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      clearRotaImportState();
      expect(rotaImportState.pending).toBe(false);
      expect(isRotaImportPending(ADMIN_ID)).toBe(false);
    });
  });

  describe('/admin-rota-print', () => {
    it('returns error when no rota loaded', async () => {
      const result = await handleAdminCommand(
        '/admin-rota-print',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No rota loaded');
    });

    it('returns PDF file when rota is loaded', async () => {
      rotaImport({
        version: 'v1-test',
        timezone: 'Europe/Berlin',
        blocks: [
          {
            key: 'lunch',
            label: 'Lunch',
            start: '10:30',
            end: '13:00',
            hours: 2.5,
            slots: 3,
          },
        ],
        big_nights: [],
        assignments: [
          {
            id: 'd1-lunch-1',
            day: 1,
            date: '2026-09-22',
            block: 'lunch',
            block_label: 'Lunch',
            slot: 1,
            start: '10:30',
            end: '13:00',
            hours: 2.5,
            weight: 2.5,
            rota_key: '@alice',
            name: 'Alice',
            telegram: '@alice',
          },
        ],
      });

      const result = await handleAdminCommand(
        '/admin-rota-print 2026-09-22',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.file).toBeDefined();
      expect(result.file!.buffer.slice(0, 5).toString()).toBe('%PDF-');
      expect(result.file!.filename).toBe('shifts-2026-09-22.pdf');
    });

    it('returns error for date with no shifts', async () => {
      rotaImport({
        version: 'v1-test',
        timezone: 'Europe/Berlin',
        blocks: [
          {
            key: 'lunch',
            label: 'Lunch',
            start: '10:30',
            end: '13:00',
            hours: 2.5,
            slots: 3,
          },
        ],
        big_nights: [],
        assignments: [],
      });

      const result = await handleAdminCommand(
        '/admin-rota-print 2026-09-30',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No shifts scheduled');
    });
  });

  describe('/admin-attendee-import', () => {
    it('sets pending state and replies with instructions', async () => {
      const result = await handleAdminCommand(
        '/admin-attendee-import',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Send me the attendee JSON file');
      expect(attendeeImportState.pending).toBe(true);
      expect(attendeeImportState.sender).toBe(ADMIN_ID);
    });

    it('isAttendeeImportPending works', async () => {
      await handleAdminCommand('/admin-attendee-import', ADMIN_ID, ADMIN_ID);
      expect(isAttendeeImportPending(ADMIN_ID)).toBe(true);
      expect(isAttendeeImportPending('other')).toBe(false);
    });

    it('handleAttendeeImportFile imports valid JSON', () => {
      const json = JSON.stringify({
        version: '1',
        event: 'Test',
        attendees: [
          { name: 'Alice', telegram: '@alice', role: 'crew' },
          { name: 'Bob', role: 'attendee' },
        ],
      });
      const result = handleAttendeeImportFile(json);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('2 attendees');
      expect(result.response).toContain('2 new');
    });

    it('handleAttendeeImportFile rejects invalid JSON', () => {
      const result = handleAttendeeImportFile('not json');
      expect(result.handled).toBe(true);
      expect(result.response).toContain('failed');
    });

    it('handleAttendeeImportFile rejects missing attendees array', () => {
      const result = handleAttendeeImportFile(JSON.stringify({ version: '1' }));
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Invalid format');
    });
  });

  describe('/admin-checkins', () => {
    it('shows no attendees when none loaded', async () => {
      const result = await handleAdminCommand(
        '/admin-checkins',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No attendees loaded');
    });

    it('shows check-in status after import', async () => {
      handleAttendeeImportFile(
        JSON.stringify({
          version: '1',
          event: 'Test',
          attendees: [
            { name: 'Alice', telegram: '@alice', role: 'crew' },
            { name: 'Bob', role: 'attendee' },
          ],
        }),
      );

      const result = await handleAdminCommand(
        '/admin-checkins',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('0/2');
      expect(result.response).toContain('Not yet checked in');
      expect(result.response).toContain('Alice');
      expect(result.response).toContain('Bob');
    });
  });
});
