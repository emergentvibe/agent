import fs from 'fs';
import path from 'path';

import { rotaGetMeta, rotaImport, rotaBindTelegramId } from '../rota-db.js';
import { setTestImportAllowed } from '../rota-db.js';
import { logger } from '../logger.js';
import { isDevMode, getDevTelegramId } from './auth.js';

export function seedDevData(): void {
  if (!isDevMode()) return;
  if (rotaGetMeta()) return;

  const fixturePath = path.resolve(
    process.cwd(),
    'tests/fixtures/rota-import.json',
  );
  if (!fs.existsSync(fixturePath)) {
    logger.info('Dev mode: no test fixture found, skipping seed');
    return;
  }

  const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  setTestImportAllowed(true);
  try {
    const result = rotaImport(payload);
    logger.info(
      { inserted: result.inserted },
      'Dev mode: seeded rota from test fixture',
    );
  } catch (err) {
    logger.warn({ err }, 'Dev mode: failed to seed rota');
    return;
  }

  const devId = getDevTelegramId();
  rotaBindTelegramId('@elliot_f', devId);
  logger.info(
    { handle: '@elliot_f', telegramId: devId },
    'Dev mode: bound dev user to test handle',
  );
}
