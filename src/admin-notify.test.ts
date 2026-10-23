import { describe, expect, it, vi } from 'vitest';

import {
  initAdminNotify,
  isAdminNotifyEnabled,
  getAdminJid,
  notifyEscalation,
  notifyError,
} from './admin-notify.js';

const resolveDmJid = (id: string) => `tg:${id}`;

describe('admin-notify', () => {
  it('is disabled when no admin ID configured', () => {
    initAdminNotify(vi.fn(), undefined, resolveDmJid);
    expect(isAdminNotifyEnabled()).toBe(false);
  });

  it('is enabled with admin ID', () => {
    initAdminNotify(vi.fn(), '123456', resolveDmJid);
    expect(isAdminNotifyEnabled()).toBe(true);
    expect(getAdminJid()).toBe('tg:123456');
  });

  it('is disabled when DM JID cannot be resolved', () => {
    initAdminNotify(vi.fn(), '123456', () => null);
    expect(isAdminNotifyEnabled()).toBe(false);
  });

  it('sends escalation notification', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    initAdminNotify(send, '123456', resolveDmJid);
    await notifyEscalation('high', 'noise concern', 'treeweek');
    expect(send).toHaveBeenCalledWith(
      'tg:123456',
      expect.stringContaining('Escalation'),
    );
    expect(send).toHaveBeenCalledWith(
      'tg:123456',
      expect.stringContaining('noise concern'),
    );
  });

  it('sends error notification', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    initAdminNotify(send, '123456', resolveDmJid);
    await notifyError('Container crash', 'OOM killed');
    expect(send).toHaveBeenCalledWith(
      'tg:123456',
      expect.stringContaining('Error'),
    );
    expect(send).toHaveBeenCalledWith(
      'tg:123456',
      expect.stringContaining('OOM killed'),
    );
  });

  it('does not throw when send fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network'));
    initAdminNotify(send, '123456', resolveDmJid);
    await notifyEscalation('low', 'test', 'test-group');
  });

  it('does nothing when disabled', async () => {
    const send = vi.fn();
    initAdminNotify(send, undefined, resolveDmJid);
    await notifyEscalation('high', 'test', 'test-group');
    expect(send).not.toHaveBeenCalled();
  });
});
