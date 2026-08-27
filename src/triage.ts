/**
 * Two-Tier Triage — cheap Haiku API call classifies messages before spawning containers.
 * Direct Anthropic API call from host process (NOT a container). ~500ms vs 3-10s container startup.
 */
import Anthropic from '@anthropic-ai/sdk';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import type { NewMessage } from './types.js';

export interface TriageMemory {
  text: string;
  user_id: string;
  metadata?: Record<string, string>;
}

export interface TriageResult {
  respond: boolean;
  memories: TriageMemory[];
  reason: string;
}

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const TRIAGE_MAX_TOKENS = 1024;

// Fail-open: if triage errors, always respond (never silently drop messages)
const FALLBACK_RESULT: TriageResult = {
  respond: true,
  memories: [],
  reason: 'triage error — fail open',
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    // Read API key from .env (not process.env — secrets stay out of env)
    const envConfig = readEnvFile(['ANTHROPIC_API_KEY']);
    const apiKey = process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY required for triage');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Visible for testing — inject a mock client */
export function _setClient(mockClient: Anthropic | null): void {
  client = mockClient;
}

function buildSystemPrompt(
  assistantName: string,
  groupName: string,
  communitySlug: string,
): string {
  return `You classify messages for a community bot called ${assistantName} in "${groupName}".

RESPOND when:
- Direct question about logistics/spaces/schedule/events
- Newcomer or someone who just arrived asking anything
- Direct address (@${assistantName}, "hey bot", "does anyone know")
- Slash command (/today, /where, /recall, /hello, /connect, /forget)
- 3+ people expressing similar concern (pattern worth surfacing)

SILENCE when:
- Casual conversation, banter, greetings between people
- Arguments or debates between members
- Social planning between specific people
- Messages that don't need bot involvement

EXTRACT MEMORIES for:
- Personal declarations (diet, pronouns, skills, interests) → user_id: "tg:{sender}"
- Operational facts (schedule changes, location updates) → user_id: "community:${communitySlug}"
- Social observations (wishes, concerns) → user_id: "community:${communitySlug}"
- Don't store banter or greetings

JSON response only: {"respond": boolean, "memories": [{"text": "...", "user_id": "..."}], "reason": "..."}`;
}

function formatMessagesForTriage(messages: NewMessage[]): string {
  return messages
    .map((m) => `[${m.sender_name || m.sender}]: ${m.content}`)
    .join('\n');
}

export async function triageMessages(
  messages: NewMessage[],
  communitySlug: string,
  groupName: string,
  assistantName: string,
): Promise<TriageResult> {
  try {
    const anthropic = getClient();

    const response = await anthropic.messages.create({
      model: TRIAGE_MODEL,
      max_tokens: TRIAGE_MAX_TOKENS,
      system: buildSystemPrompt(assistantName, groupName, communitySlug),
      messages: [
        {
          role: 'user',
          content: formatMessagesForTriage(messages),
        },
      ],
    });

    // Extract text from response
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      logger.warn('Triage response had no text block');
      return FALLBACK_RESULT;
    }

    const parsed = JSON.parse(textBlock.text) as TriageResult;

    // Validate shape
    if (typeof parsed.respond !== 'boolean' || !Array.isArray(parsed.memories)) {
      logger.warn({ parsed }, 'Triage response has invalid shape');
      return FALLBACK_RESULT;
    }

    logger.info(
      {
        respond: parsed.respond,
        memoryCount: parsed.memories.length,
        reason: parsed.reason,
      },
      'Triage result',
    );

    return parsed;
  } catch (err) {
    logger.error({ err }, 'Triage failed — falling back to respond');
    return FALLBACK_RESULT;
  }
}
