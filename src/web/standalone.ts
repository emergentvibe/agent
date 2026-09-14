import { initDatabase } from '../db.js';
import { WEB_PORT } from '../config.js';
import { logger } from '../logger.js';
import { startWebServer } from './server.js';

process.env.WEB_DEV_MODE = '1';

initDatabase();
logger.info('Database initialized (standalone web)');

startWebServer(WEB_PORT).then(() => {
  logger.info({ port: WEB_PORT }, 'Standalone web server ready');
  logger.info(`Open http://localhost:${WEB_PORT}`);
});
