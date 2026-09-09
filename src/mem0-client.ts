/**
 * Mem0 client — routes to self-hosted (OpenMemory via MCP) or cloud (HTTP API).
 *
 * Toggle: set MEM0_SSE_URL for self-hosted, MEM0_API_KEY for cloud.
 * If both are set, self-hosted wins.
 */
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import {
  initLocalMem0,
  localStoreMemory,
  localSearchMemories,
  localDeleteMemoriesByUser,
  closeLocalMem0,
  type LocalMem0Memory,
} from './mem0-local.js';

const MEM0_CLOUD_URL = 'https://api.mem0.ai/v1/memories/';

let backend: 'local' | 'cloud' | 'disabled' = 'disabled';
let cloudApiKey: string | null = null;

function detectBackend(): void {
  if (backend !== 'disabled') return;

  const envConfig = readEnvFile(['MEM0_SSE_URL', 'MEM0_API_KEY']);
  const sseUrl = process.env.MEM0_SSE_URL || envConfig.MEM0_SSE_URL;
  const apiKey = process.env.MEM0_API_KEY || envConfig.MEM0_API_KEY;

  if (sseUrl) {
    initLocalMem0(sseUrl);
    backend = 'local';
    logger.info('Mem0 backend: self-hosted (OpenMemory)');
  } else if (apiKey) {
    cloudApiKey = apiKey;
    backend = 'cloud';
    logger.info('Mem0 backend: cloud API');
  } else {
    logger.debug('No Mem0 config — memory storage disabled');
  }
}

/** Visible for testing */
export function _setApiKey(key: string | null): void {
  cloudApiKey = key;
  backend = key ? 'cloud' : 'disabled';
}

/** Visible for testing */
export function _setBackend(b: 'local' | 'cloud' | 'disabled'): void {
  backend = b;
}

export async function storeMemory(
  text: string,
  userId: string,
  metadata?: Record<string, string>,
): Promise<void> {
  detectBackend();

  if (backend === 'disabled') {
    logger.debug('Mem0 disabled, skipping memory storage');
    return;
  }

  if (backend === 'local') {
    await localStoreMemory(text, userId, metadata);
    return;
  }

  // Cloud path
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: text }],
    user_id: userId,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }

  const response = await fetch(MEM0_CLOUD_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${cloudApiKey}`,
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
  detectBackend();

  if (backend === 'disabled') return [];

  if (backend === 'local') {
    const results = await localSearchMemories(query, userId);
    return results.map((r: LocalMem0Memory) => ({
      id: r.id,
      memory: r.memory,
      user_id: r.user_id,
      metadata: r.metadata,
      created_at: r.created_at,
    }));
  }

  // Cloud path
  const response = await fetch('https://api.mem0.ai/v1/memories/search/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${cloudApiKey}`,
    },
    body: JSON.stringify({ query, user_id: userId }),
  });

  if (!response.ok) return [];

  const data = (await response.json()) as
    | Mem0Memory[]
    | { results?: Mem0Memory[] };
  return Array.isArray(data) ? data : data.results || [];
}

export async function deleteMemoriesByUser(userId: string): Promise<void> {
  detectBackend();

  if (backend === 'disabled') return;

  if (backend === 'local') {
    await localDeleteMemoriesByUser(userId);
    return;
  }

  // Cloud path
  const response = await fetch(
    `https://api.mem0.ai/v1/memories/?user_id=${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Token ${cloudApiKey}` },
    },
  );

  if (!response.ok) {
    logger.warn(
      { userId, status: response.status },
      'Failed to delete memories',
    );
  }
}

export async function closeMem0(): Promise<void> {
  if (backend === 'local') {
    await closeLocalMem0();
  }
}
