import { describe, expect, it, beforeEach } from 'vitest';

import { handleAdminCommand, isSilenced } from './admin-commands.js';
import { _initTestDatabase } from './db.js';

const ADMIN_ID = '123456';

describe('admin-commands', () => {
  beforeEach(() => {
    _initTestDatabase();
    // Reset silence state
    handleAdminCommand('/admin-silence off', ADMIN_ID, ADMIN_ID);
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
    expect(result.response).toContain('Silenced: no');
  });

  it('/admin-status reflects silence state', () => {
    handleAdminCommand('/admin-silence', ADMIN_ID, ADMIN_ID);
    const result = handleAdminCommand('/admin-status', ADMIN_ID, ADMIN_ID);
    expect(result.response).toContain('Silenced: YES');
  });

  it('non-admin commands pass through', () => {
    const result = handleAdminCommand('/hello', ADMIN_ID, ADMIN_ID);
    expect(result.handled).toBe(false);
  });
});
