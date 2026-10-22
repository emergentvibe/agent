/**
 * Admin commands — handled directly by the host, not routed to containers.
 * Recognized in DMs from the configured ADMIN_TELEGRAM_ID.
 */
import { execSync } from 'child_process';

import {
  getAllRegisteredGroups,
  getAllTasks,
  getTopics,
  setTopicExtraction,
} from './db.js';
import { logger } from './logger.js';

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
  files?: Array<{ buffer: Buffer; filename: string }>;
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
  if (!adminIds.includes(sender)) {
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
    return { handled: true, response: await buildStatusReport() };
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

  return { handled: false };
}

async function buildStatusReport(): Promise<string> {
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

  let memoryStatus = 'not configured';
  const mem0Url = process.env.MEM0_SSE_URL;
  if (mem0Url) {
    try {
      const res = await fetch('http://localhost:6333/healthz', {
        signal: AbortSignal.timeout(3000),
      });
      memoryStatus = res.ok ? 'ok' : `unhealthy (${res.status})`;
    } catch {
      memoryStatus = 'unreachable';
    }
  }

  const mode = silenced ? 'SILENCED' : degraded ? 'DEGRADED' : 'normal';

  const lines = [
    `📊 *Status Report*`,
    `Uptime: ${uptimeHrs}h`,
    `Mode: ${mode}`,
    `Groups: ${mainGroups.length} main, ${dmGroups.length} DMs`,
    `Active tasks: ${activeTasks.length}`,
    `Running containers: ${containerCount}`,
    `Memory: ${memoryStatus}`,
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

