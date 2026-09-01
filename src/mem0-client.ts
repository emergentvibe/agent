/**
 * Lightweight Mem0 API client for storing community memories.
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

  logger.debug({ userId, textLength: text.length }, 'Stored memory');
}

export interface Mem0Memory {
  id: string;
  memory: string;
  user_id: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export async function searchMemories(
  query: string,
  userId: string,
): Promise<Mem0Memory[]> {
  const key = getApiKey();
  if (!key) return [];

  const response = await fetch('https://api.mem0.ai/v1/memories/search/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${key}`,
    },
    body: JSON.stringify({ query, user_id: userId }),
  });

  if (!response.ok) return [];

  const data = (await response.json()) as { results?: Mem0Memory[] };
  return data.results || [];
}

export async function deleteMemoriesByUser(userId: string): Promise<void> {
  const key = getApiKey();
  if (!key) return;

  const response = await fetch(
    `https://api.mem0.ai/v1/memories/?user_id=${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Token ${key}` },
    },
  );

  if (!response.ok) {
    logger.warn({ userId, status: response.status }, 'Failed to delete memories');
  }
}
