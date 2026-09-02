/**
 * Admin commands — handled directly by the host, not routed to containers.
 * Recognized in DMs from the configured ADMIN_TELEGRAM_ID.
 */
import { execSync } from 'child_process';

import { getAllRegisteredGroups, getAllTasks } from './db.js';
import { logger } from './logger.js';

let silenced = false;

const startTime = Date.now();

export function isSilenced(): boolean {
  return silenced;
}

export interface AdminCommandResult {
  handled: boolean;
  response?: string;
}

export function handleAdminCommand(
  text: string,
  sender: string,
  adminTelegramId: string | undefined,
): AdminCommandResult {
  if (!adminTelegramId || sender !== adminTelegramId) {
    return { handled: false };
  }

  const cmd = text.trim().toLowerCase();

  if (cmd === '/admin-silence' || cmd === '/admin-silence on') {
    silenced = true;
    logger.warn({ sender }, 'Admin silenced the bot');
    return { handled: true, response: '🔇 Bot silenced. Send /admin-silence off to resume.' };
  }

  if (cmd === '/admin-silence off') {
    silenced = false;
    logger.info({ sender }, 'Admin un-silenced the bot');
    return { handled: true, response: '🔊 Bot resumed.' };
  }

  if (cmd === '/admin-status') {
    return { handled: true, response: buildStatusReport() };
  }

  return { handled: false };
}

function buildStatusReport(): string {
  const uptimeMs = Date.now() - startTime;
  const uptimeHrs = (uptimeMs / 3600000).toFixed(1);

  const groups = getAllRegisteredGroups();
  const mainGroups = Object.values(groups).filter((g) => g.isMain);
  const dmGroups = Object.values(groups).filter(
    (g) => !g.isMain && g.folder.includes('-dm-'),
  );

  const tasks = getAllTasks();
  const activeTasks = tasks.filter((t) => t.status === 'active');

  let containerCount = 0;
  try {
    const out = execSync(
      "docker ps --filter name=nanoclaw- --format '{{.Names}}' 2>/dev/null",
      { encoding: 'utf-8', timeout: 5000 },
    );
    containerCount = out.trim().split('\n').filter(Boolean).length;
  } catch {
    // docker not available or no containers
  }

  const lines = [
    `📊 *Status Report*`,
    `Uptime: ${uptimeHrs}h`,
    `Silenced: ${silenced ? 'YES' : 'no'}`,
    `Groups: ${mainGroups.length} main, ${dmGroups.length} DMs`,
    `Active tasks: ${activeTasks.length}`,
    `Running containers: ${containerCount}`,
  ];

  return lines.join('\n');
}
