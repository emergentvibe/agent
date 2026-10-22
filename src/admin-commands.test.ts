import { describe, expect, it, beforeEach } from 'vitest';

import {
  handleAdminCommand,
  isDegraded,
  isSilenced,
  setDegraded,
  setSilenced,
} from './admin-commands.js';
import { _initTestDatabase, setRegisteredGroup, upsertTopic } from './db.js';

const ADMIN_ID = '123456';

describe('admin-commands', () => {
  beforeEach(() => {
    _initTestDatabase();
    setSilenced(false);
    setDegraded(false);
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
});
