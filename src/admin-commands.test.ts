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
  });

  it('ignores commands from non-admin', () => {
    const result = handleAdminCommand('/admin-silence', 'other-user', ADMIN_ID);
    expect(result.handled).toBe(false);
    expect(isSilenced()).toBe(false);
  });

  it('ignores commands when no admin configured', () => {
    const result = handleAdminCommand('/admin-silence', ADMIN_ID, undefined);
    expect(result.handled).toBe(false);
  });

  it('/admin-silence enables silence', () => {
    const result = handleAdminCommand('/admin-silence', ADMIN_ID, ADMIN_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('silenced');
    expect(isSilenced()).toBe(true);
  });

  it('/admin-silence off disables silence', () => {
    handleAdminCommand('/admin-silence', ADMIN_ID, ADMIN_ID);
    expect(isSilenced()).toBe(true);

    const result = handleAdminCommand('/admin-silence off', ADMIN_ID, ADMIN_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('resumed');
    expect(isSilenced()).toBe(false);
  });

  it('/admin-status returns a report', () => {
    const result = handleAdminCommand('/admin-status', ADMIN_ID, ADMIN_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Status Report');
    expect(result.response).toContain('Uptime');
    expect(result.response).toContain('Mode: normal');
  });

  it('/admin-status reflects silence state', () => {
    handleAdminCommand('/admin-silence', ADMIN_ID, ADMIN_ID);
    const result = handleAdminCommand('/admin-status', ADMIN_ID, ADMIN_ID);
    expect(result.response).toContain('Mode: SILENCED');
  });

  it('/admin-status reflects degraded state', () => {
    setDegraded(true);
    const result = handleAdminCommand('/admin-status', ADMIN_ID, ADMIN_ID);
    expect(result.response).toContain('Mode: DEGRADED');
  });

  it('non-admin commands pass through', () => {
    const result = handleAdminCommand('/hello', ADMIN_ID, ADMIN_ID);
    expect(result.handled).toBe(false);
  });

  describe('/admin-topics', () => {
    it('shows no main groups when none registered', () => {
      const result = handleAdminCommand('/admin-topics', ADMIN_ID, ADMIN_ID);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('No main groups');
    });

    it('lists discovered topics with extraction status', () => {
      setRegisteredGroup('tg:123', {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Bot',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      });
      upsertTopic('tg:123', 2, 'Kitchen');
      upsertTopic('tg:123', 3, 'Events');

      const result = handleAdminCommand('/admin-topics', ADMIN_ID, ADMIN_ID);
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

    it('enables extraction for a topic by name', () => {
      const result = handleAdminCommand(
        '/admin-extract-on Kitchen',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('ON');
      expect(result.response).toContain('Kitchen');
    });

    it('disables extraction for a topic by id', () => {
      handleAdminCommand('/admin-extract-on 2', ADMIN_ID, ADMIN_ID);
      const result = handleAdminCommand(
        '/admin-extract-off 2',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('OFF');
    });

    it('returns not found for unknown topic', () => {
      const result = handleAdminCommand(
        '/admin-extract-on Sauna',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.response).toContain('not found');
    });
  });

  describe('/admin-tab', () => {
    it('shows all purchase totals', () => {
      storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
      storePurchase('tg:123', 'user1', 'Alice', 'wine', 5);
      storePurchase('tg:123', 'user2', 'Bob', 'burger', 5);

      const result = handleAdminCommand('/admin-tab', ADMIN_ID, ADMIN_ID);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Alice');
      expect(result.response).toContain('$8.00');
      expect(result.response).toContain('Bob');
      expect(result.response).toContain('$5.00');
    });

    it('shows user-specific purchases', () => {
      storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
      storePurchase('tg:123', 'user1', 'Alice', 'wine', 5);

      const result = handleAdminCommand('/admin-tab user1', ADMIN_ID, ADMIN_ID);
      expect(result.handled).toBe(true);
      expect(result.response).toContain('beer');
      expect(result.response).toContain('wine');
      expect(result.response).toContain('$8.00');
    });

    it('exports CSV', () => {
      storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);

      const result = handleAdminCommand(
        '/admin-tab export',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('user_id,user_name,item,price');
      expect(result.response).toContain('user1,Alice,beer,3');
    });

    it('handles no purchases', () => {
      const result = handleAdminCommand('/admin-tab', ADMIN_ID, ADMIN_ID);
      expect(result.response).toContain('No purchases');
    });
  });

  describe('/admin-rota-import', () => {
    it('sets pending state and replies with instructions', () => {
      const result = handleAdminCommand(
        '/admin-rota-import',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain('Send me the rota JSON file');
      expect(rotaImportState.pending).toBe(true);
      expect(rotaImportState.sender).toBe(ADMIN_ID);
    });

    it('shows current version when rota exists', () => {
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

      const result = handleAdminCommand(
        '/admin-rota-import',
        ADMIN_ID,
        ADMIN_ID,
      );
      expect(result.response).toContain('v1-test');
      expect(result.response).toContain('replaced');
    });

    it('isRotaImportPending returns true for correct sender', () => {
      handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      expect(isRotaImportPending(ADMIN_ID)).toBe(true);
    });

    it('isRotaImportPending returns false for wrong sender', () => {
      handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      expect(isRotaImportPending('other-user')).toBe(false);
    });

    it('isRotaImportPending returns false after expiry', () => {
      handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      rotaImportState.expiresAt = Date.now() - 1000;
      expect(isRotaImportPending(ADMIN_ID)).toBe(false);
    });

    it('clearRotaImportState resets everything', () => {
      handleAdminCommand('/admin-rota-import', ADMIN_ID, ADMIN_ID);
      clearRotaImportState();
      expect(rotaImportState.pending).toBe(false);
      expect(isRotaImportPending(ADMIN_ID)).toBe(false);
    });
  });
});
