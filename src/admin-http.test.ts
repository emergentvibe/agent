import http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  isDegraded,
  isSilenced,
  setDegraded,
  setSilenced,
} from './admin-commands.js';
import { startAdminHttp } from './admin-http.js';
import { _initTestDatabase } from './db.js';

const TOKEN = 'test-secret-token';
let server: http.Server;
let port: number;

function req(
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const r = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode!,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

describe('admin-http', () => {
  beforeAll(async () => {
    _initTestDatabase();
    server = await startAdminHttp(0, TOKEN);
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    setSilenced(false);
    setDegraded(false);
  });

  it('rejects requests without auth', async () => {
    const res = await req('GET', '/admin/status');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('rejects requests with wrong token', async () => {
    const res = await req('GET', '/admin/status', 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('GET /admin/status returns status', async () => {
    const res = await req('GET', '/admin/status', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('normal');
    expect(res.body).toHaveProperty('uptime_ms');
    expect(res.body).toHaveProperty('running_containers');
  });

  it('POST /admin/pause silences the bot', async () => {
    const res = await req('POST', '/admin/pause', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('silenced');
    expect(isSilenced()).toBe(true);
  });

  it('POST /admin/resume resumes the bot', async () => {
    setSilenced(true);
    const res = await req('POST', '/admin/resume', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('normal');
    expect(isSilenced()).toBe(false);
    expect(isDegraded()).toBe(false);
  });

  it('POST /admin/degrade enables degraded mode', async () => {
    const res = await req('POST', '/admin/degrade', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('degraded');
    expect(isDegraded()).toBe(true);
    expect(isSilenced()).toBe(false);
  });

  it('resume clears degraded state too', async () => {
    setDegraded(true);
    const res = await req('POST', '/admin/resume', TOKEN);
    expect(res.status).toBe(200);
    expect(isDegraded()).toBe(false);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await req('GET', '/admin/nonexistent', TOKEN);
    expect(res.status).toBe(404);
  });

  it('status reflects silenced mode', async () => {
    setSilenced(true);
    const res = await req('GET', '/admin/status', TOKEN);
    expect(res.body.mode).toBe('silenced');
  });

  it('status reflects degraded mode', async () => {
    setDegraded(true);
    const res = await req('GET', '/admin/status', TOKEN);
    expect(res.body.mode).toBe('degraded');
  });
});
