import { ROTA_SHIFTS_TOPIC_ID } from './config.js';
import { logger } from './logger.js';
import {
  rotaGetByDate,
  rotaGetMeta,
  rotaHasPinged,
  rotaRecordPing,
  type RotaAssignment,
} from './rota-db.js';

export interface ReminderCallbacks {
  sendToShiftsTopic: (text: string) => Promise<void>;
  sendDm: (userId: string, text: string) => Promise<void>;
  getCrewIds?: () => string[];
}

const CHECK_INTERVAL_MS = 60_000;
const SHIFT_PING_LEAD_MINUTES = 30;
const MAX_DM_PINGS_PER_DAY = 2;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let morningPostedToday: string | null = null;

function formatDate(date: string): string {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function todayStr(tz?: string): string {
  const override = process.env.DATE_OVERRIDE;
  if (override) return override;
  if (tz) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')!.value;
    const m = parts.find((p) => p.type === 'month')!.value;
    const d = parts.find((p) => p.type === 'day')!.value;
    return `${y}-${m}-${d}`;
  }
  return new Date().toISOString().slice(0, 10);
}

function nowHHMM(tz?: string): string {
  if (tz) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const h = parts.find((p) => p.type === 'hour')!.value;
    const m = parts.find((p) => p.type === 'minute')!.value;
    return `${h}:${m}`;
  }
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function subtractMinutes(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  let totalMin = h * 60 + m - mins;
  if (totalMin < 0) totalMin = 0;
  return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
}

function formatAssignmentLine(a: RotaAssignment): string {
  if (a.state === 'open') {
    return `  ${a.original_name || '???'} ${a.original_telegram || ''} — cover needed`.trim();
  }
  if (a.state === 'covered') {
    return `  ${a.original_name || '???'} → ${a.current_name || '???'} ${a.current_telegram || ''} covering`.trim();
  }
  const tag = a.original_telegram_id ? a.original_telegram || '' : '';
  return `  ${a.current_name || a.original_name || '???'} ${tag}`.trim();
}

export function buildMorningAnnouncement(
  today: string,
  assignments: RotaAssignment[],
): string {
  if (assignments.length === 0) return '';

  const blockGroups = new Map<string, RotaAssignment[]>();
  for (const a of assignments) {
    const key = `${a.start}–${a.end} ${a.block_label}`;
    if (!blockGroups.has(key)) blockGroups.set(key, []);
    blockGroups.get(key)!.push(a);
  }

  const lines: string[] = [`Kitchen shifts for ${formatDate(today)}\n`];
  for (const [block, slots] of blockGroups) {
    lines.push(`${block}`);
    for (const s of slots) {
      lines.push(formatAssignmentLine(s));
    }
    lines.push('');
  }

  const openCount = assignments.filter((a) => a.state === 'open').length;
  if (openCount > 0) {
    lines.push(
      `${openCount} open slot${openCount > 1 ? 's' : ''} — tap to claim!`,
    );
  }

  return lines.join('\n').trim();
}

function dmPingCountToday(
  today: string,
  telegramId: string,
  assignments: RotaAssignment[],
): number {
  let count = 0;
  for (const a of assignments) {
    if (a.date === today && rotaHasPinged(a.id, `dm_${telegramId}`)) {
      count++;
    }
  }
  return count;
}

async function tick(callbacks: ReminderCallbacks): Promise<void> {
  const meta = rotaGetMeta();
  if (!meta) return;

  const tz = meta.timezone || undefined;
  const today = todayStr(tz);
  const now = nowHHMM(tz);
  const assignments = rotaGetByDate(today);

  if (assignments.length === 0) return;

  if (morningPostedToday !== today && now >= '08:00' && ROTA_SHIFTS_TOPIC_ID) {
    const announcement = buildMorningAnnouncement(today, assignments);
    if (announcement) {
      try {
        await callbacks.sendToShiftsTopic(announcement);
        morningPostedToday = today;
        logger.info('Rota: morning announcement posted');
      } catch (err) {
        logger.error({ err }, 'Rota: failed to post morning announcement');
      }
    }
  }

  const pingWindow = subtractMinutes(now, -SHIFT_PING_LEAD_MINUTES);

  for (const a of assignments) {
    if (a.state !== 'assigned') continue;
    if (!a.original_telegram_id) continue;

    const pingKey = `dm_${a.original_telegram_id}`;
    if (rotaHasPinged(a.id, pingKey)) continue;

    const pingTime = subtractMinutes(a.start, SHIFT_PING_LEAD_MINUTES);
    if (now < pingTime || now > a.start) continue;

    if (
      dmPingCountToday(today, a.original_telegram_id, assignments) >=
      MAX_DM_PINGS_PER_DAY
    ) {
      continue;
    }

    try {
      await callbacks.sendDm(
        a.original_telegram_id,
        `Heads up — you're on ${a.block_label} (${a.start}–${a.end}) today.`,
      );
      rotaRecordPing(a.id, pingKey);
      logger.info(
        { assignmentId: a.id, telegramId: a.original_telegram_id },
        'Rota: DM ping sent',
      );
    } catch (err) {
      logger.error({ err, assignmentId: a.id }, 'Rota: failed to send DM ping');
    }
  }

  // Warn about uncovered shifts 30 minutes before they start
  for (const a of assignments) {
    if (a.state !== 'open') continue;

    const warnKey = 'open_warning';
    if (rotaHasPinged(a.id, warnKey)) continue;

    const warnTime = subtractMinutes(a.start, SHIFT_PING_LEAD_MINUTES);
    if (now < warnTime || now > a.start) continue;

    try {
      if (ROTA_SHIFTS_TOPIC_ID) {
        await callbacks.sendToShiftsTopic(
          `⚠️ ${a.block_label} (${a.start}–${a.end}) starts in 30 min — still needs coverage!`,
        );
      }

      // DM the original person — they're still on the hook
      if (a.original_telegram_id) {
        await callbacks.sendDm(
          a.original_telegram_id,
          `Your ${a.block_label} (${a.start}–${a.end}) shift starts in 30 min and nobody picked it up yet. You're still on the hook — head to the kitchen!`,
        );
      }

      const crewIds = callbacks.getCrewIds?.() || [];
      for (const crewId of crewIds) {
        if (crewId === a.original_telegram_id) continue;
        await callbacks.sendDm(
          crewId,
          `Heads up — ${a.block_label} (${a.start}–${a.end}) starts soon and has no one assigned.`,
        );
      }

      rotaRecordPing(a.id, warnKey);
      logger.info({ assignmentId: a.id }, 'Rota: uncovered shift warning sent');
    } catch (err) {
      logger.error(
        { err, assignmentId: a.id },
        'Rota: failed to send uncovered shift warning',
      );
    }
  }
}

export function startRotaReminders(callbacks: ReminderCallbacks): void {
  if (intervalHandle) {
    logger.warn('Rota reminders already running');
    return;
  }

  logger.info('Rota reminders started (60s interval)');
  intervalHandle = setInterval(() => {
    tick(callbacks).catch((err) => {
      logger.error({ err }, 'Rota reminder tick failed');
    });
  }, CHECK_INTERVAL_MS);

  tick(callbacks).catch((err) => {
    logger.error({ err }, 'Rota reminder initial tick failed');
  });
}

export function stopRotaReminders(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Rota reminders stopped');
  }
}

export function _resetForTests(): void {
  morningPostedToday = null;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
