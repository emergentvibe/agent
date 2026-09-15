import { getToday } from '../config.js';
import { logger } from '../logger.js';
import { searchMemories, type Mem0Memory } from '../mem0-client.js';
import type { RegisteredGroup } from '../types.js';

const SCHEDULE_CACHE_INTERVAL = parseInt(
  process.env.SCHEDULE_CACHE_INTERVAL || '300000',
  10,
);

const SCHEDULE_TOP_N = parseInt(process.env.SCHEDULE_TOP_N || '3', 10);
const SCHEDULE_FLOOR_SCORE = parseFloat(
  process.env.SCHEDULE_FLOOR_SCORE || '0.25',
);

function formatTodayForQuery(): string {
  const today = getToday();
  const d = new Date(today + 'T12:00:00');
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function buildScheduleQueries(): string[] {
  const label = formatTodayForQuery();
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

let cachedUpdates: ScheduleUpdate[] = [];
let cacheTime = 0;

export function getCachedUpdates(): ScheduleUpdate[] {
  return cachedUpdates;
}

export function getCacheAge(): number {
  return cacheTime ? Date.now() - cacheTime : Infinity;
}

export function setCachedUpdates(updates: ScheduleUpdate[]): void {
  cachedUpdates = updates;
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
    const queries = buildScheduleQueries();
    const seen = new Set<string>();
    const selected: Mem0Memory[] = [];

    let totalReturned = 0;
    let belowFloor = 0;
    let dedupHits = 0;

    for (const query of queries) {
      const results = await searchMemories(query, userId);
      totalReturned += results.length;
      logger.info(
        {
          query,
          resultCount: results.length,
          results: results.map((m) => ({
            id: m.id.slice(0, 8),
            score: m.score,
            memory: m.memory.slice(0, 100),
          })),
        },
        'SCHEDULE_QUERY: raw results',
      );
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
        seen.add(m.id);
        selected.push(m);
        taken++;
      }
    }

    logger.info(
      { selectedCount: selected.length, totalReturned, dedupHits, belowFloor },
      'SCHEDULE_CACHE: selection summary',
    );

    const updates: ScheduleUpdate[] = selected.map((m) => ({
      memory: m.memory,
      source: extractSource(m.metadata),
      created_at: m.created_at,
    }));

    setCachedUpdates(updates);
    logger.info(
      {
        count: updates.length,
        topN: SCHEDULE_TOP_N,
        queries: queries.length,
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
