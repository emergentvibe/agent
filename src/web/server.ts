import { createServer, IncomingMessage, ServerResponse, Server } from 'http';

import { logger } from '../logger.js';
import { handleApi } from './api.js';
import {
  createWebToken,
  getWebToken,
  parseCookieToken,
  setTokenCookie,
  isDevMode,
  getDevTelegramId,
} from './auth.js';
import {
  renderToday,
  renderMyShifts,
  renderHelp,
  renderKitchen,
} from './templates.js';
import { seedDevData } from './dev-seed.js';

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res: ServerResponse, url: string): void {
  res.writeHead(302, { Location: url });
  res.end();
}

function getTelegramId(req: IncomingMessage): string | null {
  if (isDevMode()) return getDevTelegramId();
  const token = parseCookieToken(req.headers.cookie);
  if (!token) return null;
  const wt = getWebToken(token);
  return wt?.telegram_id || null;
}

function ensureCookie(
  req: IncomingMessage,
  res: ServerResponse,
): string | null {
  const existing = parseCookieToken(req.headers.cookie);
  if (existing) {
    const wt = getWebToken(existing);
    if (wt) return existing;
  }
  if (isDevMode()) return null;
  const token = createWebToken();
  res.setHeader('Set-Cookie', setTokenCookie(token));
  return token;
}

export function startWebServer(port: number): Promise<Server> {
  seedDevData();
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const pathname = url.pathname;

        if (await handleApi(req, res, pathname)) return;

        const webToken = ensureCookie(req, res);
        const telegramId = getTelegramId(req);

        switch (pathname) {
          case '/':
            html(res, 200, renderToday(telegramId, webToken));
            break;
          case '/my-shifts':
            html(res, 200, renderMyShifts(telegramId, webToken));
            break;
          case '/help':
            html(res, 200, renderHelp());
            break;
          case '/kitchen':
            html(res, 200, renderKitchen());
            break;
          default:
            html(
              res,
              404,
              '<!DOCTYPE html><html><body style="background:#0d1118;color:#f1ead9;font-family:system-ui;text-align:center;padding:80px"><h1>404</h1></body></html>',
            );
        }
      } catch (err) {
        logger.error({ err, url: req.url }, 'Web server error');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      }
    });

    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Web server listening');
      resolve(server);
    });
  });
}
