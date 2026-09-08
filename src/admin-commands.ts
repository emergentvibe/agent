/**
 * Admin commands — handled directly by the host, not routed to containers.
 * Recognized in DMs from the configured ADMIN_TELEGRAM_ID.
 */
import { execSync } from 'child_process';

import {
  attendeeCount,
  attendeeGetCheckedIn,
  attendeeGetNotCheckedIn,
  attendeeImport,
  isAttendeeAdmin,
  type AttendeeImportPayload,
} from './attendee-db.js';
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
import { rotaGetMeta, rotaReset, rotaExportBackup } from './rota-db.js';
import { generateRotaPdf, parsePrintArgs } from './rota-print.js';

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
  file?: { buffer: Buffer; filename: string };
}

export async function handleAdminCommand(
  text: string,
  sender: string,
  adminTelegramId: string | undefined,
): Promise<AdminCommandResult> {
  const adminIds = (adminTelegramId || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isEnvAdmin = adminIds.includes(sender);
  const isOrgAdmin = isAttendeeAdmin(sender);
  if (!isEnvAdmin && !isOrgAdmin) {
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
    degraded = false;
    logger.info({ sender }, 'Admin un-silenced the bot');
    return { handled: true, response: '🔊 Bot resumed.' };
  }

  if (cmd === '/admin-degrade' || cmd === '/admin-degrade on') {
    silenced = false;
    degraded = true;
    logger.warn({ sender }, 'Admin set bot to degraded mode');
    return {
      handled: true,
      response:
        '🌙 Bot in degraded mode — replies "taking a break" when tagged. Extraction continues.\nSend /admin-silence off to resume.',
    };
  }

  if (cmd === '/admin-degrade off') {
    degraded = false;
    logger.info({ sender }, 'Admin exited degraded mode');
    return { handled: true, response: '🔊 Bot resumed from degraded mode.' };
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
    if (arg.toLowerCase() === 'export') {
      const result = buildTabExportFile();
      if ('error' in result) return { handled: true, response: result.error };
      return { handled: true, file: result };
    }
    return { handled: true, response: buildTabReport(arg) };
  }

  if (cmd.startsWith('/admin-rota-print')) {
    const date = parsePrintArgs(text.trim());
    const result = await generateRotaPdf(date);
    if ('error' in result) {
      return { handled: true, response: result.error };
    }
    return { handled: true, file: result };
  }

  if (cmd === '/admin-rota-backup') {
    const backup = rotaExportBackup();
    if (!backup) {
      return { handled: true, response: 'No rota loaded.' };
    }
    const json = JSON.stringify(backup, null, 2);
    const buffer = Buffer.from(json, 'utf-8');
    const date = new Date().toISOString().slice(0, 10);
    return {
      handled: true,
      file: { buffer, filename: `rota-backup-${date}.json` },
    };
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

  if (cmd === '/admin-attendee-import') {
    const counts = attendeeCount();
    const hint =
      counts.total > 0
        ? `Current: ${counts.total} attendees (${counts.checked_in} checked in). Import will update matching names.`
        : 'No attendees loaded.';
    attendeeImportState.pending = true;
    attendeeImportState.sender = sender;
    attendeeImportState.expiresAt = Date.now() + 5 * 60 * 1000;
    return {
      handled: true,
      response: `${hint}\nSend me the attendee JSON file. (Expires in 5 minutes.)`,
    };
  }

  if (cmd === '/admin-checkins') {
    return { handled: true, response: buildCheckinsReport() };
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

// --- Attendee import state ---

export const attendeeImportState = {
  pending: false,
  sender: '',
  expiresAt: 0,
};

export function isAttendeeImportPending(sender: string): boolean {
  if (
    !attendeeImportState.pending ||
    attendeeImportState.sender !== sender ||
    Date.now() > attendeeImportState.expiresAt
  ) {
    attendeeImportState.pending = false;
    return false;
  }
  return true;
}

export function clearAttendeeImportState(): void {
  attendeeImportState.pending = false;
  attendeeImportState.sender = '';
  attendeeImportState.expiresAt = 0;
}

export function handleAttendeeImportFile(
  jsonString: string,
): AdminCommandResult {
  clearAttendeeImportState();
  try {
    const payload = JSON.parse(jsonString) as AttendeeImportPayload;
    if (!payload.attendees || !Array.isArray(payload.attendees)) {
      return {
        handled: true,
        response: 'Invalid format: expected { attendees: [...] }',
      };
    }
    const result = attendeeImport(payload);
    return {
      handled: true,
      response: `Imported ${result.total} attendees (${result.created} new, ${result.updated} updated).`,
    };
  } catch (err) {
    return {
      handled: true,
      response: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function buildCheckinsReport(): string {
  const counts = attendeeCount();
  if (counts.total === 0)
    return 'No attendees loaded. Use /admin-attendee-import first.';

  const checkedIn = attendeeGetCheckedIn();
  const notCheckedIn = attendeeGetNotCheckedIn();

  const lines = [
    `*Check-in Status* (${counts.checked_in}/${counts.total})`,
    '',
  ];

  if (checkedIn.length > 0) {
    lines.push('*Checked in:*');
    for (const a of checkedIn) {
      const handle = a.telegram_handle || '';
      const role = a.role !== 'attendee' ? ` [${a.role}]` : '';
      lines.push(`  ${a.name} ${handle}${role}`);
    }
    lines.push('');
  }

  if (notCheckedIn.length > 0) {
    lines.push(`*Not yet checked in (${notCheckedIn.length}):*`);
    for (const a of notCheckedIn) {
      const handle = a.telegram_handle || '(no handle)';
      lines.push(`  ${a.name} ${handle}`);
    }
  }

  return lines.join('\n');
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
      lines.push(`${t.user_name}: €${t.total.toFixed(2)}`);
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
      `${p.item}: €${p.price.toFixed(2)} (${p.timestamp.slice(0, 10)})`,
    );
    total += p.price;
  }
  lines.push(`\n*Total: €${total.toFixed(2)}*`);
  return lines.join('\n');
}

function csvSafe(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  if (value.includes(',') || value.includes('"'))
    return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildTabExportFile():
  | { buffer: Buffer; filename: string }
  | { error: string } {
  const purchases = getAllPurchases();
  if (purchases.length === 0) return { error: 'No purchases to export.' };
  const lines = ['user_id,user_name,item,price,timestamp'];
  for (const p of purchases) {
    lines.push(
      `${csvSafe(p.user_id)},${csvSafe(p.user_name)},${csvSafe(p.item)},${p.price},${p.timestamp}`,
    );
  }
  lines.push('');
  lines.push('--- TOTALS ---');
  const totals = getAllPurchaseTotals();
  lines.push('user_name,total');
  for (const t of totals) {
    lines.push(`${csvSafe(t.user_name)},${t.total.toFixed(2)}`);
  }
  const grandTotal = totals.reduce((sum, t) => sum + t.total, 0);
  lines.push(`TOTAL,${grandTotal.toFixed(2)}`);
  const csv = lines.join('\n') + '\n';
  const date = new Date().toISOString().slice(0, 10);
  return {
    buffer: Buffer.from(csv, 'utf-8'),
    filename: `purchases-${date}.csv`,
  };
}
