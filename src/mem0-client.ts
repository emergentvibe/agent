/**
 * Lightweight Mem0 API client for storing memories from triage.
 * Bypasses MCP — direct HTTP to Mem0 cloud API.
 */
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const MEM0_API_URL = 'https://api.mem0.ai/v1/memories/';

let apiKey: string | null = null;

function getApiKey(): string | null {
  if (apiKey !== null) return apiKey || null;
  const envConfig = readEnvFile(['MEM0_API_KEY']);
  apiKey = process.env.MEM0_API_KEY || envConfig.MEM0_API_KEY || '';
  return apiKey || null;
}

/** Visible for testing */
export function _setApiKey(key: string | null): void {
  apiKey = key;
}

export async function storeMemory(
  text: string,
  userId: string,
  metadata?: Record<string, string>,
): Promise<void> {
  const key = getApiKey();
  if (!key) {
    logger.debug('MEM0_API_KEY not set, skipping memory storage');
    return;
  }

  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: text }],
    user_id: userId,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }

  const response = await fetch(MEM0_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => 'no body');
    throw new Error(`Mem0 API error ${response.status}: ${responseText}`);
  }

  logger.debug({ userId, textLength: text.length }, 'Stored triage memory');
}
