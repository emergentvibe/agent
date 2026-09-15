import { initDatabase } from '../db.js';
import { WEB_PORT } from '../config.js';
import { logger } from '../logger.js';
import { startWebServer } from './server.js';
import { setCachedUpdates } from './schedule-refresh.js';

process.env.WEB_DEV_MODE = '1';

initDatabase();
logger.info('Database initialized (standalone web)');

setCachedUpdates([
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
  {
    memory:
      'Multiple people (Alex, Priya, River) expressed interest in morning lake swimming',
    source: undefined,
    created_at: new Date(Date.now() - 6 * 3600000).toISOString(),
  },
  {
    memory: 'Wifi password changed to oak2026',
    source: 'Jordan',
    created_at: new Date(Date.now() - 12 * 3600000).toISOString(),
  },
]);

startWebServer(WEB_PORT).then(() => {
  logger.info({ port: WEB_PORT }, 'Standalone web server ready');
  logger.info(`Open http://localhost:${WEB_PORT}`);
});
