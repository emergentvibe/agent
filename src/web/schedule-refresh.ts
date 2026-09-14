import { logger } from '../logger.js';
import { searchMemories, type Mem0Memory } from '../mem0-client.js';
import type { RegisteredGroup } from '../types.js';

const SCHEDULE_CACHE_INTERVAL = parseInt(
  process.env.SCHEDULE_CACHE_INTERVAL || '300000',
  10,
);

const SCHEDULE_QUERIES = [
  'schedule changes today events times',
  'cancelled events activities',
  'new events announcements workshops',
];

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

function deduplicateMemories(memories: Mem0Memory[]): Mem0Memory[] {
  const seen = new Set<string>();
  return memories.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export interface ScheduleCacheDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

async function refreshScheduleCache(deps: ScheduleCacheDeps): Promise<void> {
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
    const allResults: Mem0Memory[] = [];
    for (const query of SCHEDULE_QUERIES) {
      const results = await searchMemories(query, userId);
      allResults.push(...results);
    }

    const unique = deduplicateMemories(allResults);

    const updates: ScheduleUpdate[] = unique.map((m) => ({
      memory: m.memory,
      source: extractSource(m.metadata),
      created_at: m.created_at,
    }));

    setCachedUpdates(updates);
    logger.info(
      { count: updates.length },
      'Schedule cache updated from Mem0',
    );
  } catch (err) {
    logger.error({ err }, 'Schedule cache refresh failed');
  }
}

let running = false;

export function startScheduleCacheLoop(deps: ScheduleCacheDeps): void {
  if (running) return;
  running = true;

  logger.info(
    { intervalMs: SCHEDULE_CACHE_INTERVAL },
    'Schedule cache loop started',
  );

  const tick = () => {
    refreshScheduleCache(deps).catch((err) =>
      logger.error({ err }, 'Schedule cache tick error'),
    );
  };

  const initialDelay = Math.min(15_000, SCHEDULE_CACHE_INTERVAL);
  setTimeout(() => {
    tick();
    setInterval(tick, SCHEDULE_CACHE_INTERVAL);
  }, initialDelay);
}
