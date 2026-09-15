import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDatabase } from '../db.js';
import { WEB_PORT } from '../config.js';
import { logger } from '../logger.js';
import { startWebServer } from './server.js';
import { setCachedUpdates, type ScheduleUpdate } from './schedule-refresh.js';

process.env.WEB_DEV_MODE = '1';

initDatabase();
logger.info('Database initialized (standalone web)');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.resolve(__dirname, 'seed-data.json');
// Also check in src/ for when running from dist/
const srcSeedPath = path.resolve(__dirname, '../../src/web/seed-data.json');

function loadSeedData(): ScheduleUpdate[] {
  for (const p of [seedPath, srcSeedPath]) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as ScheduleUpdate[];
        logger.info({ path: p, count: data.length }, 'Loaded seed data from sim');
        return data;
      } catch (err) {
        logger.warn({ err, path: p }, 'Failed to parse seed data');
      }
    }
  }

  logger.info('No seed-data.json found, using hardcoded fallback');
  return [
    {
      memory:
        'Dinner moved from 7pm to 6pm tonight due to kitchen availability (updated by Jordan)',
      source: 'Jordan',
      created_at: new Date(Date.now() - 45 * 60000).toISOString(),
    },
    {
      memory: 'Morning yoga cancelled tomorrow — instructor rest day',
      source: 'Maya',
      created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
    },
    {
      memory:
        'Community bonfire at 9pm tonight at the fire pit by the lake — bring instruments if you have them',
      source: 'Jordan',
      created_at: new Date(Date.now() - 30 * 60000).toISOString(),
    },
    {
      memory:
        'Basket weaving workshop tomorrow at 3pm in the garden shed, space for 12 people, bring scissors, reeds provided',
      source: 'Alex',
      created_at: new Date(Date.now() - 4 * 3600000).toISOString(),
    },
  ];
}

setCachedUpdates(loadSeedData());

startWebServer(WEB_PORT).then(() => {
  logger.info({ port: WEB_PORT }, 'Standalone web server ready');
  logger.info(`Open http://localhost:${WEB_PORT}`);
});
