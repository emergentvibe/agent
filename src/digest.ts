/**
 * Daily digest — ensures a cron task exists for each group with daily_digest enabled.
 * The task runs every morning and posts a brief summary to the group.
 */
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { createTask, getTasksForGroup } from './db.js';
import { loadFeatureConfig } from './feature-config.js';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';
import type { RegisteredGroup } from './types.js';

const DIGEST_TASK_ID_PREFIX = 'daily-digest-';
const CREW_DIGEST_TASK_ID_PREFIX = 'crew-digest-';
const DIGEST_CRON = '0 8 * * *'; // 8am daily
const CREW_DIGEST_CRON = '0 23 * * *'; // 11pm daily

function buildDigestPrompt(groupName: string, slug: string): string {
  const templatePath = path.join(
    process.cwd(),
    'governance/templates/digest-prompt.md',
  );
  if (fs.existsSync(templatePath)) {
    return fs
      .readFileSync(templatePath, 'utf-8')
      .replace(/\{\{community_name\}\}/g, groupName)
      .replace(/\{\{slug\}\}/g, slug);
  }

  // Inline fallback if template doesn't exist
  return `Search community memories from the last 24 hours for "${groupName}" (community:${slug}). Summarize:
1. Today's scheduled events
2. Any operational changes since yesterday
3. Emerging patterns (if any)

Format as a brief morning message. Be warm but concise. If nothing notable happened, say so in one sentence.`;
}

export function ensureDigestTask(
  group: RegisteredGroup,
  chatJid: string,
): void {
  const features = loadFeatureConfig(group.folder);
  if (!features.behaviors.daily_digest) return;

  const taskId = `${DIGEST_TASK_ID_PREFIX}${group.folder}`;
  const existing = getTasksForGroup(group.folder);
  const hasDigest = existing.some(
    (t) => t.id === taskId && t.status === 'active',
  );

  if (hasDigest) return;

  const slug = group.folder;
  const prompt = buildDigestPrompt(group.name, slug);

  createTask({
    id: taskId,
    group_folder: group.folder,
    chat_jid: chatJid,
    prompt,
    schedule_type: 'cron',
    schedule_value: DIGEST_CRON,
    context_mode: 'group',
    next_run: nextCronRun(DIGEST_CRON),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info(
    { group: group.name, taskId },
    'Created daily digest task',
  );
}

function buildCrewDigestPrompt(
  groupName: string,
  slug: string,
  groupFolder: string,
): string {
  const templatePath = path.join(
    process.cwd(),
    'governance/templates/crew-digest-prompt.md',
  );
  if (fs.existsSync(templatePath)) {
    return fs
      .readFileSync(templatePath, 'utf-8')
      .replace(/\{\{community_name\}\}/g, groupName)
      .replace(/\{\{slug\}\}/g, slug)
      .replace(/\{\{group_folder\}\}/g, groupFolder);
  }

  return `Compile an evening crew digest for "${groupName}" (community:${slug}). Search memories for today's activity, changes, and patterns. Check data/escalations/${groupFolder}/ for anonymous reports. Keep it under 200 words.`;
}

export function ensureCrewDigestTask(
  group: RegisteredGroup,
  crewDmJid: string,
  crewMemberId: string,
): void {
  const features = loadFeatureConfig(group.folder);
  if (!features.behaviors.crew_digest) return;

  const taskId = `${CREW_DIGEST_TASK_ID_PREFIX}${group.folder}-${crewMemberId}`;
  const existing = getTasksForGroup(group.folder);
  const hasTask = existing.some(
    (t) => t.id === taskId && t.status === 'active',
  );

  if (hasTask) return;

  const prompt = buildCrewDigestPrompt(group.name, group.folder, group.folder);

  createTask({
    id: taskId,
    group_folder: group.folder,
    chat_jid: crewDmJid,
    prompt,
    schedule_type: 'cron',
    schedule_value: CREW_DIGEST_CRON,
    context_mode: 'group',
    next_run: nextCronRun(CREW_DIGEST_CRON),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info(
    { group: group.name, taskId, crewDmJid },
    'Created crew digest task',
  );
}

function nextCronRun(cron: string): string {
  const interval = CronExpressionParser.parse(cron, {
    tz: TIMEZONE,
  });
  return interval.next().toISOString() as string;
}
