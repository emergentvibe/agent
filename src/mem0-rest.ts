/**
 * REST client for OpenMemory's /api/v1 endpoints + Qdrant direct access.
 *
 * Used for store operations where we need `infer: false` to bypass
 * OpenMemory's internal LLM extraction. The MCP interface doesn't
 * expose this param, so we hit the REST API directly.
 *
 * Also provides a Qdrant scroll path for bulk memory retrieval —
 * the MCP search_memory tool is hardcoded to 10 results, so schedule
 * refresh uses Qdrant directly to get ALL memories and filters on host.
 */
import { logger } from './logger.js';

const APP_NAME = 'nanoclaw';

let baseUrl: string | null = null;
let qdrantUrl: string | null = null;

export function initMem0Rest(url: string): void {
  baseUrl = url;
  const parsed = new URL(url);
  qdrantUrl = `${parsed.protocol}//${parsed.hostname}:6333`;
  logger.info({ baseUrl, qdrantUrl }, 'Mem0 REST client configured');
}

export function isRestReady(): boolean {
  return baseUrl !== null;
}

export interface QdrantMemory {
  id: string;
  memory: string;
  created_at?: string;
}

export async function qdrantDateScroll(
  userId: string,
  patterns: string[],
): Promise<QdrantMemory[]> {
  if (!qdrantUrl) return [];
  const res = await fetch(`${qdrantUrl}/collections/openmemory/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: {
        must: [{ key: 'user_id', match: { value: userId } }],
        should: patterns.map((p) => ({ key: 'data', match: { text: p } })),
      },
      limit: 100,
      with_payload: true,
    }),
  });
  if (!res.ok) return [];
  const d = (await res.json()) as {
    result?: {
      points?: {
        id: string;
        payload?: { data?: string; created_at?: string };
      }[];
    };
  };
  return (
    d.result?.points?.map((p) => ({
      id: p.id,
      memory: p.payload?.data ?? '',
      created_at: p.payload?.created_at,
    })) ?? []
  );
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
