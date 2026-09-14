import { IncomingMessage, ServerResponse } from 'http';

import { getToday } from '../config.js';
import {
  rotaGetByDate,
  rotaGetByTelegramId,
  rotaGetOpenSlots,
} from '../rota-db.js';
import {
  getWebToken,
  parseCookieToken,
  isDevMode,
  getDevTelegramId,
  linkWebToken,
} from './auth.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function getTelegramId(req: IncomingMessage): string | null {
  if (isDevMode()) return getDevTelegramId();
  const token = parseCookieToken(req.headers.cookie);
  if (!token) return null;
  const wt = getWebToken(token);
  return wt?.telegram_id || null;
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/me') {
    const telegramId = getTelegramId(req);
    if (!telegramId) {
      json(res, 200, { authenticated: false });
    } else {
      const token = parseCookieToken(req.headers.cookie);
      const wt = token ? getWebToken(token) : undefined;
      json(res, 200, {
        authenticated: true,
        telegram_id: telegramId,
        name: wt?.telegram_name || null,
      });
    }
    return true;
  }

  if (pathname === '/api/shifts/today') {
    const today = getToday();
    const shifts = rotaGetByDate(today);
    json(res, 200, { date: today, shifts });
    return true;
  }

  if (pathname === '/api/shifts/mine') {
    const telegramId = getTelegramId(req);
    if (!telegramId) {
      json(res, 401, { error: 'not authenticated' });
      return true;
    }
    const shifts = rotaGetByTelegramId(telegramId);
    json(res, 200, { shifts });
    return true;
  }

  if (pathname === '/api/shifts/open') {
    const open = rotaGetOpenSlots();
    json(res, 200, { shifts: open });
    return true;
  }

  if (pathname === '/dev/link' && isDevMode()) {
    const url = new URL(req.url || '', 'http://localhost');
    const telegramId = url.searchParams.get('telegram_id');
    if (!telegramId) {
      json(res, 400, { error: 'telegram_id required' });
      return true;
    }
    const token = parseCookieToken(req.headers.cookie);
    if (token) {
      linkWebToken(token, telegramId, `Dev User ${telegramId}`);
    }
    json(res, 200, { linked: true, telegram_id: telegramId });
    return true;
  }

  if (pathname === '/api/link' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { token: linkToken, telegram_id, name } = JSON.parse(body);
      if (!linkToken || !telegram_id) {
        json(res, 400, { error: 'token and telegram_id required' });
        return true;
      }
      const ok = linkWebToken(linkToken, telegram_id, name || 'Unknown');
      json(res, ok ? 200 : 404, { linked: ok });
    } catch {
      json(res, 400, { error: 'invalid json' });
    }
    return true;
  }

  return false;
}
