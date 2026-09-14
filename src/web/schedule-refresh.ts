import { ChildProcess } from 'child_process';

import { ASSISTANT_NAME } from '../config.js';
import { runContainerAgent, ContainerOutput } from '../container-runner.js';
import { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { setCachedSchedule } from './schedule.js';

const SCHEDULE_CACHE_INTERVAL = parseInt(
  process.env.SCHEDULE_CACHE_INTERVAL || '3600000',
  10,
);

const SCHEDULE_PROMPT = `List today's complete schedule with times. Include any changes from the original plan that you find in memory — time changes, cancellations, new events. Note who announced changes. Keep it concise: one line per event, time first.`;

export interface ScheduleCacheDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
}

async function refreshScheduleCache(deps: ScheduleCacheDeps): Promise<void> {
  const groups = deps.registeredGroups();
  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
  if (!mainEntry) {
    logger.debug('Schedule cache: no main group registered yet');
    return;
  }

  const [chatJid, group] = mainEntry;
  logger.info('Refreshing schedule cache via container agent');

  let result: string | null = null;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: SCHEDULE_PROMPT,
        groupFolder: group.folder,
        chatJid: `schedule-cache:${chatJid}`,
        isMain: true,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        maxTurns: 3,
      },
      (_proc: ChildProcess, _containerName: string) => {},
      async (streamed: ContainerOutput) => {
        if (streamed.result) {
          result = streamed.result;
        }
      },
    );

    if (!result && output.result) {
      result = output.result;
    }

    if (result) {
      setCachedSchedule(result);
      logger.info(
        { length: result.length },
        'Schedule cache updated from agent',
      );
    } else {
      logger.warn('Schedule cache refresh returned no result');
    }
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

  // First refresh after a short delay (let extraction run first)
  const initialDelay = Math.min(30_000, SCHEDULE_CACHE_INTERVAL);
  setTimeout(() => {
    tick();
    setInterval(tick, SCHEDULE_CACHE_INTERVAL);
  }, initialDelay);
}
