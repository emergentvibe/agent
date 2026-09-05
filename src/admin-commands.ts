/**
 * Admin commands — handled directly by the host, not routed to containers.
 * Recognized in DMs from the configured ADMIN_TELEGRAM_ID.
 */
import { execSync } from 'child_process';

import {
  getAllPurchases,
  getAllPurchaseTotals,
  getAllRegisteredGroups,
  getAllTasks,
  getUserPurchases,
  getTopics,
  setTopicExtraction,
} from './db.js';
import { logger } from './logger.js';
import { rotaGetMeta, rotaReset } from './rota-db.js';

let silenced = false;
let degraded = false;

const startTime = Date.now();

export function isSilenced(): boolean {
  return silenced;
}

export function setSilenced(value: boolean): void {
  silenced = value;
}

export function isDegraded(): boolean {
  return degraded;
}

export function setDegraded(value: boolean): void {
  degraded = value;
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
    return {
      handled: true,
      response: '🔇 Bot silenced. Send /admin-silence off to resume.',
    };
  }

  if (cmd === '/admin-silence off') {
    silenced = false;
    logger.info({ sender }, 'Admin un-silenced the bot');
    return { handled: true, response: '🔊 Bot resumed.' };
  }

  if (cmd === '/admin-status') {
    return { handled: true, response: buildStatusReport() };
  }

  if (cmd === '/admin-topics') {
    return { handled: true, response: buildTopicReport() };
  }

  if (cmd.startsWith('/admin-extract-on ')) {
    const target = text.trim().slice('/admin-extract-on '.length).trim();
    return { handled: true, response: toggleTopicExtraction(target, true) };
  }

  if (cmd.startsWith('/admin-extract-off ')) {
    const target = text.trim().slice('/admin-extract-off '.length).trim();
    return { handled: true, response: toggleTopicExtraction(target, false) };
  }

  if (cmd.startsWith('/admin-tab')) {
    const arg = text.trim().slice('/admin-tab'.length).trim();
    return { handled: true, response: buildTabReport(arg) };
  }

  if (cmd === '/admin-rota-import') {
    const meta = rotaGetMeta();
    const hint = meta
      ? `Current rota: version ${meta.version} (will be replaced on import).`
      : 'No rota loaded.';
    rotaImportState.pending = true;
    rotaImportState.sender = sender;
    rotaImportState.expiresAt = Date.now() + 5 * 60 * 1000;
    return {
      handled: true,
      response: `${hint}\nSend me the rota JSON file. (Expires in 5 minutes.)`,
    };
  }

  return { handled: false };
}

// --- Rota import state ---

export const rotaImportState = {
  pending: false,
  sender: '',
  expiresAt: 0,
};

export function isRotaImportPending(sender: string): boolean {
  if (
    !rotaImportState.pending ||
    rotaImportState.sender !== sender ||
    Date.now() > rotaImportState.expiresAt
  ) {
    rotaImportState.pending = false;
    return false;
  }
  return true;
}

export function clearRotaImportState(): void {
  rotaImportState.pending = false;
  rotaImportState.sender = '';
  rotaImportState.expiresAt = 0;
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

  const mode = silenced ? 'SILENCED' : degraded ? 'DEGRADED' : 'normal';

  const lines = [
    `📊 *Status Report*`,
    `Uptime: ${uptimeHrs}h`,
    `Mode: ${mode}`,
    `Groups: ${mainGroups.length} main, ${dmGroups.length} DMs`,
    `Active tasks: ${activeTasks.length}`,
    `Running containers: ${containerCount}`,
  ];

  return lines.join('\n');
}

export function getStatusJson(): Record<string, unknown> {
  const uptimeMs = Date.now() - startTime;
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

  return {
    mode: silenced ? 'silenced' : degraded ? 'degraded' : 'normal',
    uptime_ms: uptimeMs,
    groups: { main: mainGroups.length, dm: dmGroups.length },
    active_tasks: activeTasks.length,
    running_containers: containerCount,
  };
}

function buildTopicReport(): string {
  const groups = getAllRegisteredGroups();
  const mainGroups = Object.entries(groups).filter(([, g]) => g.isMain);

  if (mainGroups.length === 0) {
    return 'No main groups registered.';
  }

  const lines: string[] = ['*Forum Topics*\n'];
  for (const [jid, group] of mainGroups) {
    lines.push(`*${group.name}*`);
    const topics = getTopics(jid);
    if (topics.length === 0) {
      lines.push('  No topics discovered yet.');
    } else {
      for (const t of topics) {
        const status = t.extraction_enabled ? 'ON' : 'OFF';
        lines.push(`  ${t.name} (id:${t.thread_id}) — extraction: ${status}`);
      }
    }
  }
  lines.push('\nGeneral topic always has extraction ON.');
  return lines.join('\n');
}

function toggleTopicExtraction(target: string, enabled: boolean): string {
  const groups = getAllRegisteredGroups();
  const mainGroups = Object.entries(groups).filter(([, g]) => g.isMain);

  for (const [jid] of mainGroups) {
    const topics = getTopics(jid);
    // Match by name (case-insensitive) or thread_id
    const match = topics.find(
      (t) =>
        t.name.toLowerCase() === target.toLowerCase() ||
        t.thread_id.toString() === target,
    );
    if (match) {
      setTopicExtraction(jid, match.thread_id, enabled);
      const status = enabled ? 'ON' : 'OFF';
      logger.info(
        { topic: match.name, threadId: match.thread_id, enabled },
        'Topic extraction toggled',
      );
      return `Extraction ${status} for "${match.name}" (id:${match.thread_id}).`;
    }
  }
  return `Topic "${target}" not found. Use /admin-topics to see available topics.`;
}

function buildTabReport(arg: string): string {
  if (!arg) {
    const totals = getAllPurchaseTotals();
    if (totals.length === 0) return 'No purchases recorded.';
    const lines = ['*Purchase Totals*\n'];
    for (const t of totals) {
      lines.push(`${t.user_name}: $${t.total.toFixed(2)}`);
    }
    return lines.join('\n');
  }

  if (arg.toLowerCase() === 'export') {
    const purchases = getAllPurchases();
    if (purchases.length === 0) return 'No purchases to export.';
    const lines = ['user_id,user_name,item,price,timestamp'];
    for (const p of purchases) {
      lines.push(
        `${p.user_id},${p.user_name},${p.item},${p.price},${p.timestamp}`,
      );
    }
    return lines.join('\n');
  }

  // Treat as user lookup — strip @ if present
  const userId = arg.replace(/^@/, '');
  const purchases = getUserPurchases(userId);
  if (purchases.length === 0) return `No purchases for user "${userId}".`;
  const lines = [`*Purchases for ${purchases[0].user_name}*\n`];
  let total = 0;
  for (const p of purchases) {
    lines.push(
      `${p.item}: $${p.price.toFixed(2)} (${p.timestamp.slice(0, 10)})`,
    );
    total += p.price;
  }
  lines.push(`\n*Total: $${total.toFixed(2)}*`);
  return lines.join('\n');
}
