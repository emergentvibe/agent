import crypto from 'crypto';

import { _getDb } from '../db.js';

export interface WebToken {
  token: string;
  telegram_id: string | null;
  telegram_name: string | null;
  created_at: string;
  expires_at: string;
}

export function createWebToken(): string {
  const db = _getDb();
  const token = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  db.prepare(
    `INSERT INTO web_tokens (token, telegram_id, telegram_name, created_at, expires_at) VALUES (?, NULL, NULL, ?, ?)`,
  ).run(token, now.toISOString(), expires.toISOString());

  return token;
}

export function getWebToken(token: string): WebToken | undefined {
  const db = _getDb();
  const row = db
    .prepare('SELECT * FROM web_tokens WHERE token = ?')
    .get(token) as WebToken | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM web_tokens WHERE token = ?').run(token);
    return undefined;
  }
  return row;
}

export function linkWebToken(
  token: string,
  telegramId: string,
  name: string,
): boolean {
  const db = _getDb();
  const result = db
    .prepare(
      `UPDATE web_tokens SET telegram_id = ?, telegram_name = ? WHERE token = ? AND telegram_id IS NULL`,
    )
    .run(telegramId, name, token);
  return result.changes > 0;
}

export function isDevMode(): boolean {
  return !!(process.env.SIM_MODE || process.env.WEB_DEV_MODE);
}

export function getDevTelegramId(): string {
  return process.env.DEV_TELEGRAM_ID || '12345678';
}

export function parseCookieToken(
  cookieHeader: string | undefined,
): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|;\s*)tw_token=([a-f0-9]+)/);
  return match?.[1];
}

export function setTokenCookie(token: string): string {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
  return `tw_token=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`;
}
