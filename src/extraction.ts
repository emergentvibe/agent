/**
 * Background extraction — runs on interval, scans group chat messages,
 * extracts events, schedules, and activity proposals into Mem0.
 * Uses a 60-min sliding window for context so cross-batch Q&A pairs aren't lost.
 */
import fs from 'fs';
import path from 'path';

import Anthropic from '@anthropic-ai/sdk';

import { notifyError } from './admin-notify.js';
import {
  EXTRACTION_INTERVAL,
  EXTRACTION_WINDOW,
  MIN_CONTEXT_MESSAGES,
} from './config.js';
import {
  getMessagesBefore,
  getMessagesInTimeRange,
  getMessagesSince,
  getRouterState,
  isExtractionEnabled,
  setRouterState,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { loadFeatureConfig } from './feature-config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { storeMemory } from './mem0-client.js';
import {
  findMatchingSubscriptions,
  getSubscriptions,
} from './subscriptions.js';
import type { NewMessage, RegisteredGroup } from './types.js';

export interface ExtractionMemory {
  text: string;
  user_id: string;
  metadata?: Record<string, string>;
}

export interface ExtractionResult {
  memories: ExtractionMemory[];
}

const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACTION_MAX_TOKENS = 2048;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const envConfig = readEnvFile(['ANTHROPIC_API_KEY']);
    const apiKey = process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY required for extraction');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Visible for testing */
export function _setClient(mockClient: Anthropic | null): void {
  client = mockClient;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatMessagesForExtraction(messages: NewMessage[]): string {
  return messages
    .map(
      (m) =>
        `[${formatTime(m.timestamp)} ${m.sender_name || m.sender}]: ${m.content}`,
    )
    .join('\n');
}

export function buildExtractionPrompt(
  groupName: string,
  communitySlug: string,
  contextMessages: NewMessage[],
  newMessages: NewMessage[],
  subscriptionTopics: string[] = [],
): string {
  const contextBlock =
    contextMessages.length > 0
      ? `## CONTEXT (recent messages for reference — do NOT extract from these)\n${formatMessagesForExtraction(contextMessages)}\n\n`
      : '';

  const subscriptionBlock =
    subscriptionTopics.length > 0
      ? `\n## Active subscriptions
People have subscribed to notifications about: ${subscriptionTopics.join(', ')}
If a message contains a substantive mention of any of these topics — an event, announcement, proposal, or update about it — extract it even if it doesn't fit the categories above. Do NOT extract personal information even if it matches a subscription keyword.\n`
      : '';

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return `You extract event and activity information from group chat messages for "${groupName}".
Your output will be stored in a semantic search database for future retrieval.
Current date and time: ${todayStr}, ${timeStr}.
Always use absolute dates (e.g., "Thu 25 Sep"), never relative dates like "today", "tonight", "tomorrow", "yesterday".
Use 24-hour times in all extracted text (e.g., "21:00" not "9pm"). Each message below has a 24-hour timestamp in brackets — use it to disambiguate bare times, but ONLY for same-day events: if someone posts at 20:15 about something "at 9" today, that means 21:00. But "tomorrow at 9" or any future date with a bare time defaults to morning (09:00) unless context says otherwise (e.g., "tomorrow evening at 9" = 21:00). A "tonight" or "this evening" event is always after 17:00. If you truly cannot determine the time, include both possibilities.

${contextBlock}## NEW MESSAGES (extract from these only)
${formatMessagesForExtraction(newMessages)}

## What to extract

EVENT/ACTIVITY ANNOUNCEMENTS — workshops, gatherings, scheduled activities:
- "Workshop at 15:00 in the garden on Thu 25 Sep (announced by Alex)"
- Write complete, search-friendly sentences with absolute dates and 24-hour times

SCHEDULE CHANGES — times, venues, cancellations:
- When something CHANGES, include what changed: "Dinner moved from 19:00 to 18:30 on Thu 25 Sep (updated by Alex)"

FACILITY STATUS — infrastructure that affects everyone:
- "Hot water is out in building B (reported by River)"
- "Wifi password changed to oak2026 (announced by Jordan)"

ACTIVITY PROPOSALS — things people want to organize:
- "Alex proposed a music jam at 20:00 on Thu 25 Sep in the barn"

PATTERNS — when 2+ people propose the same activity:
- "Multiple people (Alex, Priya, River) expressed interest in morning lake swimming"

## What NOT to extract
- Introductions, skills, interests, personal identity (handled by /hello)
- Diet, pronouns, health, emotional state, relationships
- Rota/shift assignments, cover swaps (managed by separate system)
- Purchase/tab activity
- Greetings, banter, jokes, thanks, emoji reactions
- Questions without answers
- Social coordination between individuals
- Opinions, arguments, complaints about people
- Third-party claims about anyone
- Anything from the CONTEXT section (already processed)
${subscriptionBlock}
## Output format
JSON array: [{"text": "...", "user_id": "community:${communitySlug}", "metadata": {"type": "fact|proposal|pattern", "topic": "...", "tier": "operational", "source": "[name]", "source_context": "group"}}]
Return [] if nothing worth extracting.`;
}

export async function extractMemories(
  newMessages: NewMessage[],
  contextMessages: NewMessage[],
  communitySlug: string,
  groupName: string,
  subscriptionTopics: string[] = [],
): Promise<ExtractionResult> {
  if (newMessages.length === 0) return { memories: [] };

  try {
    const anthropic = getClient();

    const response = await anthropic.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: EXTRACTION_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: buildExtractionPrompt(
            groupName,
            communitySlug,
            contextMessages,
            newMessages,
            subscriptionTopics,
          ),
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      logger.warn('Extraction response had no text block');
      return { memories: [] };
    }

    const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.debug('Extraction returned no JSON array (likely empty)');
      return { memories: [] };
    }

    let parsed: ExtractionMemory[];
    try {
      parsed = JSON.parse(jsonMatch[0]) as ExtractionMemory[];
    } catch {
      const codeBlock = textBlock.text.match(
        /```(?:json)?\s*(\[[\s\S]*?\])\s*```/,
      );
      if (codeBlock) {
        parsed = JSON.parse(codeBlock[1]) as ExtractionMemory[];
      } else {
        logger.warn(
          { raw: jsonMatch[0].slice(0, 200) },
          'Extraction returned unparseable JSON',
        );
        return { memories: [] };
      }
    }
    if (!Array.isArray(parsed)) {
      logger.warn('Extraction response is not an array');
      return { memories: [] };
    }

    logger.info(
      { memoryCount: parsed.length, groupName },
      'Extraction complete',
    );

    return { memories: parsed };
  } catch (err) {
    logger.error({ err, groupName }, 'Extraction failed');
    return { memories: [] };
  }
}

interface ExtractionLoopDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  assistantName: string;
}

let extractionTimestamps: Record<string, string> = {};

function loadExtractionTimestamps(): void {
  const stored = getRouterState('last_extraction_timestamp');
  try {
    extractionTimestamps = stored ? JSON.parse(stored) : {};
  } catch {
    extractionTimestamps = {};
  }
}

function saveExtractionTimestamps(): void {
  setRouterState(
    'last_extraction_timestamp',
    JSON.stringify(extractionTimestamps),
  );
}

async function runExtractionCycle(deps: ExtractionLoopDeps): Promise<void> {
  const groups = deps.registeredGroups();
  const now = new Date();
  const windowStart = new Date(now.getTime() - EXTRACTION_WINDOW).toISOString();

  for (const [chatJid, group] of Object.entries(groups)) {
    if (!group.isMain) continue;

    const lastExtracted = extractionTimestamps[chatJid] || '';
    const communitySlug = group.folder;

    const allNewMessages = getMessagesSince(
      chatJid,
      lastExtracted,
      deps.assistantName,
    );

    if (allNewMessages.length === 0) continue;

    // Filter out messages from topics where extraction is disabled
    const newMessages = allNewMessages.filter((m) =>
      isExtractionEnabled(chatJid, m.thread_id),
    );

    // Still advance the cursor even if all messages were filtered out
    if (newMessages.length === 0) {
      extractionTimestamps[chatJid] =
        allNewMessages[allNewMessages.length - 1].timestamp;
      saveExtractionTimestamps();
      continue;
    }

    // Context: messages from the sliding window that were already extracted.
    // Falls back to last N messages if the time window is too narrow (e.g.,
    // conversation gap > EXTRACTION_WINDOW, or synthetic timestamps in sim).
    let contextMessages = lastExtracted
      ? getMessagesInTimeRange(
          chatJid,
          windowStart,
          lastExtracted,
          deps.assistantName,
        )
      : [];

    if (contextMessages.length < MIN_CONTEXT_MESSAGES && lastExtracted) {
      contextMessages = getMessagesBefore(
        chatJid,
        lastExtracted,
        deps.assistantName,
        MIN_CONTEXT_MESSAGES,
      );
    }

    const subs = getSubscriptions(group.folder);
    const topics = [...new Set(subs.map((s) => s.topic))];

    logger.info(
      {
        group: group.name,
        newCount: newMessages.length,
        contextCount: contextMessages.length,
        subscriptionTopics: topics.length,
      },
      'Running memory extraction',
    );

    const result = await extractMemories(
      newMessages,
      contextMessages,
      communitySlug,
      group.name,
      topics,
    );

    for (const mem of result.memories) {
      logger.info(
        { text: mem.text, metadata: mem.metadata, userId: mem.user_id },
        'EXTRACTION_STORE: sending to Mem0',
      );
    }

    const storeResults = await Promise.allSettled(
      result.memories.map((mem) =>
        storeMemory(mem.text, mem.user_id, mem.metadata),
      ),
    );
    let storeFailures = 0;
    for (const r of storeResults) {
      if (r.status === 'rejected') {
        storeFailures++;
        logger.warn({ err: r.reason }, 'Failed to store extracted memory');
      }
    }

    // Notify subscribers even on partial success
    const features = loadFeatureConfig(group.folder);
    if (features.commands.subscribe && result.memories.length > 0) {
      notifySubscribers(group.folder, result.memories);
    }

    // Don't advance cursor if most stores failed — retry next cycle
    if (
      result.memories.length > 0 &&
      storeFailures > result.memories.length / 2
    ) {
      logger.warn(
        { storeFailures, total: result.memories.length, group: group.name },
        'Mem0 store failure rate >50% — cursor not advanced, will retry',
      );
      continue;
    }

    extractionTimestamps[chatJid] =
      newMessages[newMessages.length - 1].timestamp;
    saveExtractionTimestamps();
  }
}

function notifySubscribers(
  groupFolder: string,
  memories: ExtractionMemory[],
): void {
  for (const mem of memories) {
    const matches = findMatchingSubscriptions(groupFolder, mem.text);
    if (matches.length === 0) continue;

    const ipcDir = path.join(resolveGroupIpcPath(groupFolder), 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });

    for (const sub of matches) {
      const notification = {
        type: 'message',
        chatJid: sub.chatJid,
        text: `🔔 ${sub.topic} — ${mem.text}`,
      };
      const filename = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      fs.writeFileSync(
        path.join(ipcDir, filename),
        JSON.stringify(notification),
      );
      logger.info(
        { userId: sub.userId, topic: sub.topic },
        'Subscription notification queued',
      );
    }
  }
}

export function startExtractionLoop(deps: ExtractionLoopDeps): void {
  loadExtractionTimestamps();

  logger.info(
    { intervalMs: EXTRACTION_INTERVAL },
    'Starting background memory extraction loop',
  );

  const scheduleNext = () => {
    setTimeout(async () => {
      try {
        await runExtractionCycle(deps);
      } catch (err) {
        logger.error({ err }, 'Extraction cycle error');
        notifyError(
          'Extraction cycle failed',
          err instanceof Error ? err.message : String(err),
        ).catch(() => {});
      }
      scheduleNext();
    }, EXTRACTION_INTERVAL);
  };
  scheduleNext();
}
