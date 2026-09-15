/**
 * REST client for OpenMemory's /api/v1 endpoints.
 *
 * Used for store operations where we need `infer: false` to bypass
 * OpenMemory's internal LLM extraction. The MCP interface doesn't
 * expose this param, so we hit the REST API directly.
 *
 * Search stays on MCP (semantic search with scores works well there).
 */
import { logger } from './logger.js';

const APP_NAME = 'nanoclaw';

let baseUrl: string | null = null;

export function initMem0Rest(url: string): void {
  baseUrl = url;
  logger.info({ baseUrl }, 'Mem0 REST client configured (infer=false)');
}

export function isRestReady(): boolean {
  return baseUrl !== null;
}

export async function restStoreMemory(
  text: string,
  userId: string,
  metadata?: Record<string, string>,
): Promise<void> {
  if (!baseUrl)
    throw new Error('Mem0 REST not initialized — call initMem0Rest()');

  const body: Record<string, unknown> = {
    user_id: userId,
    text,
    infer: false,
    app: APP_NAME,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }

  const response = await fetch(`${baseUrl}/api/v1/memories/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => 'no body');
    throw new Error(`Mem0 REST store failed (${response.status}): ${errBody}`);
  }

  logger.debug(
    { userId, textLength: text.length },
    'Stored memory (REST, infer=false)',
  );
}
