import { createServer, IncomingMessage, ServerResponse, Server } from 'http';

import {
  getStatusJson,
  isDegraded,
  isSilenced,
  setDegraded,
  setSilenced,
} from './admin-commands.js';
import { logger } from './logger.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startAdminHttp(port: number, token: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      await readBody(req);

      if (!token) {
        json(res, 503, { error: 'ADMIN_HTTP_TOKEN not configured' });
        return;
      }

      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }

      const url = req.url;
      const method = req.method;

      if (method === 'GET' && url === '/admin/status') {
        json(res, 200, getStatusJson());
        return;
      }

      if (method === 'POST' && url === '/admin/pause') {
        setSilenced(true);
        logger.warn('Admin HTTP: bot paused');
        json(res, 200, { mode: 'silenced' });
        return;
      }

      if (method === 'POST' && url === '/admin/resume') {
        setSilenced(false);
        setDegraded(false);
        logger.info('Admin HTTP: bot resumed');
        json(res, 200, { mode: 'normal' });
        return;
      }

      if (method === 'POST' && url === '/admin/degrade') {
        setSilenced(false);
        setDegraded(true);
        logger.warn('Admin HTTP: bot degraded');
        json(res, 200, { mode: 'degraded' });
        return;
      }

      json(res, 404, { error: 'not found' });
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'Admin HTTP server listening');
      resolve(server);
    });
  });
}
