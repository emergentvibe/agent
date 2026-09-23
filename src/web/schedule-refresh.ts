import { getToday } from '../config.js';
import { logger } from '../logger.js';
import { searchMemories, type Mem0Memory } from '../mem0-client.js';
import { getFullWeekSchedule } from './schedule.js';
import type { RegisteredGroup } from '../types.js';

const SCHEDULE_CACHE_INTERVAL = parseInt(
  process.env.SCHEDULE_CACHE_INTERVAL || '300000',
  10,
);

const SCHEDULE_TOP_N = parseInt(process.env.SCHEDULE_TOP_N || '3', 10);
const SCHEDULE_FLOOR_SCORE = parseFloat(
  process.env.SCHEDULE_FLOOR_SCORE || '0.25',
);

function formatDateForQuery(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function getDayFromDate(dateStr: string): number {
  const d = new Date(dateStr + 'T12:00:00');
  return d.getDate();
}

const SEP_DATE_RE = /\b(\d{1,2})\s+Sep(?:tember)?\b/gi;
const DAY_NUM_RE = /\bday\s+(\d{1,2})\b/gi;

export function isDateRelevant(memory: string, targetDay: number): boolean {
  const mentionedDates = new Set<number>();
  let match;

  SEP_DATE_RE.lastIndex = 0;
  while ((match = SEP_DATE_RE.exec(memory)) !== null) {
    mentionedDates.add(parseInt(match[1], 10));
  }

  DAY_NUM_RE.lastIndex = 0;
  while ((match = DAY_NUM_RE.exec(memory)) !== null) {
    const dayNum = parseInt(match[1], 10);
    if (dayNum >= 1 && dayNum <= 8) {
      mentionedDates.add(21 + dayNum);
    }
  }

  if (mentionedDates.size === 0) return true;
  return mentionedDates.has(targetDay);
}

export function buildScheduleQueries(dateStr: string): string[] {
  const label = formatDateForQuery(dateStr);
  return [
    `meal times schedule changes ${label}`,
    `events cancelled or moved ${label}`,
    `what is happening ${label} activities events`,
  ];
}

export interface ScheduleUpdate {
  memory: string;
  source?: string;
  created_at?: string;
}

const cachedUpdatesByDate = new Map<string, ScheduleUpdate[]>();
let cacheTime = 0;

export function getCachedUpdates(): ScheduleUpdate[] {
  const today = getToday();
  return cachedUpdatesByDate.get(today) || [];
}

export function getCachedUpdatesForDate(dateStr: string): ScheduleUpdate[] {
  return cachedUpdatesByDate.get(dateStr) || [];
}

export function getCacheAge(): number {
  return cacheTime ? Date.now() - cacheTime : Infinity;
}

export function setCachedUpdates(updates: ScheduleUpdate[]): void {
  const today = getToday();
  cachedUpdatesByDate.set(today, updates);
  cacheTime = Date.now();
}

function extractSource(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  const source = metadata.source;
  return typeof source === 'string' ? source : undefined;
}

export interface ScheduleCacheDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

async function refreshForDate(
  dateStr: string,
  targetDay: number,
  userId: string,
): Promise<ScheduleUpdate[]> {
  const queries = buildScheduleQueries(dateStr);
  const seen = new Set<string>();
  const selected: Mem0Memory[] = [];

  let totalReturned = 0;
  let belowFloor = 0;
  let dedupHits = 0;
  let wrongDate = 0;

  for (const query of queries) {
    const results = await searchMemories(query, userId);
    totalReturned += results.length;
    let taken = 0;
    for (const m of results) {
      if (taken >= SCHEDULE_TOP_N) break;
      if (seen.has(m.id)) {
        dedupHits++;
        continue;
      }
      if (m.score !== undefined && m.score < SCHEDULE_FLOOR_SCORE) {
        belowFloor++;
        continue;
      }
      if (!isDateRelevant(m.memory, targetDay)) {
        wrongDate++;
        continue;
      }
      seen.add(m.id);
      selected.push(m);
      taken++;
    }
  }

  logger.info(
    {
      date: dateStr,
      selectedCount: selected.length,
      totalReturned,
      dedupHits,
      belowFloor,
      wrongDate,
      targetDay,
    },
    'SCHEDULE_CACHE: selection summary',
  );

  return selected.map((m) => ({
    memory: m.memory,
    source: extractSource(m.metadata),
    created_at: m.created_at,
  }));
}

export async function refreshScheduleCache(
  deps: ScheduleCacheDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
  if (!mainEntry) {
    logger.debug('Schedule cache: no main group registered yet');
    return;
  }

  const [, group] = mainEntry;
  const communitySlug = group.folder;
  const userId = `community:${communitySlug}`;

  try {
    const week = getFullWeekSchedule();

    for (const day of week) {
      const targetDay = getDayFromDate(day.date);
      const updates = await refreshForDate(day.date, targetDay, userId);
      cachedUpdatesByDate.set(day.date, updates);
    }

    cacheTime = Date.now();

    const today = getToday();
    const todayCount = cachedUpdatesByDate.get(today)?.length || 0;
    logger.info(
      {
        daysRefreshed: week.length,
        todayUpdates: todayCount,
        totalUpdates: Array.from(cachedUpdatesByDate.values()).reduce(
          (sum, u) => sum + u.length,
          0,
        ),
      },
      'Schedule cache updated from Mem0',
    );
  } catch (err) {
    logger.error({ err }, 'Schedule cache refresh failed');
  }
}

let running = false;

export function startScheduleCacheLoop(
  deps: ScheduleCacheDeps,
  onRefreshed?: () => Promise<void>,
): void {
  if (running) return;
  running = true;

  logger.info(
    { intervalMs: SCHEDULE_CACHE_INTERVAL },
    'Schedule cache loop started',
  );

  const tick = () => {
    refreshScheduleCache(deps)
      .then(() => onRefreshed?.())
      .catch((err) => logger.error({ err }, 'Schedule cache tick error'));
  };

  const initialDelay = Math.min(15_000, SCHEDULE_CACHE_INTERVAL);
  setTimeout(() => {
    tick();
    setInterval(tick, SCHEDULE_CACHE_INTERVAL);
  }, initialDelay);
}
