import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initMem0Rest, restStoreMemory, isRestReady } from './mem0-rest.js';

describe('mem0-rest', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    initMem0Rest('http://localhost:8765');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('isRestReady returns true after init', () => {
    expect(isRestReady()).toBe(true);
  });

  it('sends POST with infer=false and app=nanoclaw', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    await restStoreMemory('Dinner at 6pm tonight', 'community:treeweek');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8765/api/v1/memories/');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.user_id).toBe('community:treeweek');
    expect(body.text).toBe('Dinner at 6pm tonight');
    expect(body.infer).toBe(false);
    expect(body.app).toBe('nanoclaw');
  });

  it('includes metadata when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    await restStoreMemory('Yoga at 7am', 'community:treeweek', {
      source: 'extraction',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ source: 'extraction' });
  });

  it('omits metadata when empty', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    await restStoreMemory('Yoga at 7am', 'community:treeweek');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toBeUndefined();
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(restStoreMemory('test', 'community:treeweek')).rejects.toThrow(
      'Mem0 REST store failed (500)',
    );
  });
});
