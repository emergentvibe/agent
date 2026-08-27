import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import { storeMemory, _setApiKey } from './mem0-client.js';

describe('storeMemory', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _setApiKey(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('skips when no API key is set', async () => {
    _setApiKey('');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await storeMemory('test memory', 'tg:user1');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts to Mem0 API with correct format', async () => {
    _setApiKey('test-mem0-key');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });

    await storeMemory('Alice is vegan', 'tg:user1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.mem0.ai/v1/memories/',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Token test-mem0-key',
        },
      }),
    );

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.messages[0].content).toBe('Alice is vegan');
    expect(body.user_id).toBe('tg:user1');
  });

  it('includes metadata when provided', async () => {
    _setApiKey('test-mem0-key');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });

    await storeMemory('schedule changed', 'community:edge', {
      type: 'operational',
    });

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.metadata).toEqual({ type: 'operational' });
  });

  it('throws on API error', async () => {
    _setApiKey('test-mem0-key');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limited'),
    });

    await expect(storeMemory('test', 'tg:user1')).rejects.toThrow(
      'Mem0 API error 429: rate limited',
    );
  });
});
