/**
 * Background memory extraction — runs on interval, scans group chat messages,
 * extracts community knowledge into Mem0 without spawning containers.
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
  setRouterState,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { loadFeatureConfig } from './feature-config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { storeMemory } from './mem0-client.js';
import { findMatchingSubscriptions } from './subscriptions.js';
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

function formatMessagesForExtraction(messages: NewMessage[]): string {
  return messages
    .map((m) => `[${m.sender_name || m.sender}]: ${m.content}`)
    .join('\n');
}

function buildExtractionPrompt(
  groupName: string,
  communitySlug: string,
  contextMessages: NewMessage[],
  newMessages: NewMessage[],
): string {
  const contextBlock =
    contextMessages.length > 0
      ? `## CONTEXT (recent messages for reference — do NOT extract from these)\n${formatMessagesForExtraction(contextMessages)}\n\n`
      : '';

  return `You extract community knowledge from group chat messages for "${groupName}".
Your output will be stored in a semantic search database for future retrieval.

${contextBlock}## NEW MESSAGES (extract knowledge from these only)
${formatMessagesForExtraction(newMessages)}

## What to extract

OPERATIONAL FACTS — schedules, locations, logistics, facility status:
- Write complete, search-friendly sentences: "The sauna is heated daily from 4pm to 10pm"
- When a fact CHANGES, include what changed: "Dinner moved from 7pm to 6:30pm (updated by Alex)"
- Include WHO said it: "Alex mentioned the printer is on the second floor"

PERSONAL DECLARATIONS shared in group — diet, pronouns, skills, interests:
- "Sam introduced themselves as a photographer from Berlin interested in street photography"

WISHES and CONCERNS — things people want or worry about:
- "River expressed concern about noise levels after 10pm in the garden"
- If 2+ people express similar things, note the pattern: "Multiple people (Alex, Priya) mentioned wanting morning swimming"

## What NOT to extract
- Greetings, banter, jokes, emoji reactions
- Questions without answers (queries are not knowledge)
- Social coordination between specific people
- Arguments or opinions (unless they contain a factual update)
- Anything from the CONTEXT section (already processed)

## Output format
JSON array: [{"text": "...", "user_id": "community:${communitySlug}", "metadata": {"type": "fact|introduction|wish|concern|pattern", "topic": "...", "tier": "operational|social", "source": "[name]", "source_context": "group"}}]
Return [] if nothing worth extracting.`;
}

export async function extractMemories(
  newMessages: NewMessage[],
  contextMessages: NewMessage[],
  communitySlug: string,
  groupName: string,
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

    const newMessages = getMessagesSince(
      chatJid,
      lastExtracted,
      deps.assistantName,
    );

    if (newMessages.length === 0) continue;

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

    logger.info(
      {
        group: group.name,
        newCount: newMessages.length,
        contextCount: contextMessages.length,
      },
      'Running memory extraction',
    );

    const result = await extractMemories(
      newMessages,
      contextMessages,
      communitySlug,
      group.name,
    );

    for (const mem of result.memories) {
      storeMemory(mem.text, mem.user_id, mem.metadata).catch((err) =>
        logger.warn({ err }, 'Failed to store extracted memory'),
      );
    }

    // Notify subscribers of matching memories
    const features = loadFeatureConfig(group.folder);
    if (features.commands.subscribe && result.memories.length > 0) {
      notifySubscribers(group.folder, result.memories);
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
        text: `Heads up: ${mem.text}`,
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
