import { describe, expect, it, vi } from 'vitest';

import {
  initAdminNotify,
  isAdminNotifyEnabled,
  getAdminJid,
  notifyEscalation,
  notifyError,
} from './admin-notify.js';

describe('admin-notify', () => {
  it('is disabled when no admin ID configured', () => {
    initAdminNotify(vi.fn(), undefined);
    expect(isAdminNotifyEnabled()).toBe(false);
  });

  it('is enabled with admin ID', () => {
    initAdminNotify(vi.fn(), '123456');
    expect(isAdminNotifyEnabled()).toBe(true);
    expect(getAdminJid()).toBe('tg:123456');
  });

  it('sends escalation notification', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    initAdminNotify(send, '123456');
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
    initAdminNotify(send, '123456');
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
    initAdminNotify(send, '123456');
    await notifyEscalation('low', 'test', 'test-group');
  });

  it('does nothing when disabled', async () => {
    const send = vi.fn();
    initAdminNotify(send, undefined);
    await notifyEscalation('high', 'test', 'test-group');
    expect(send).not.toHaveBeenCalled();
  });
});
