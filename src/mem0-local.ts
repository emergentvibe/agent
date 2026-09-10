/**
 * Self-hosted Mem0 (OpenMemory) client via MCP over SSE.
 * Connects to a local OpenMemory instance and calls its MCP tools.
 * Users are auto-created on first memory add.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { logger } from './logger.js';

const CLIENT_NAME = 'nanoclaw';

interface McpConnection {
  client: Client;
  transport: SSEClientTransport;
  userId: string;
}

const connections = new Map<string, McpConnection>();
let baseUrl: string | null = null;

export function initLocalMem0(sseUrl: string): void {
  const url = new URL(sseUrl);
  baseUrl = `${url.protocol}//${url.host}`;
  logger.info({ baseUrl }, 'Self-hosted Mem0 (OpenMemory) configured');
}

async function getConnection(userId: string): Promise<McpConnection> {
  const existing = connections.get(userId);
  if (existing) return existing;

  if (!baseUrl)
    throw new Error('Local Mem0 not initialized — call initLocalMem0()');

  const sseUrl = new URL(
    `/mcp/${CLIENT_NAME}/sse/${encodeURIComponent(userId)}`,
    baseUrl,
  );

  const transport = new SSEClientTransport(sseUrl);
  const client = new Client({ name: CLIENT_NAME, version: '1.0.0' });

  await client.connect(transport);
  logger.debug({ userId }, 'MCP connection established to OpenMemory');

  const conn: McpConnection = { client, transport, userId };
  connections.set(userId, conn);
  return conn;
}

export async function localStoreMemory(
  text: string,
  userId: string,
  _metadata?: Record<string, string>,
): Promise<void> {
  const conn = await getConnection(userId);
  const result = await conn.client.callTool({
    name: 'add_memories',
    arguments: { text },
  });

  const content = result.content as Array<{ type: string; text?: string }>;
  const responseText = content?.find((c) => c.type === 'text')?.text || '';

  if (responseText.startsWith('Error:')) {
    throw new Error(`OpenMemory add_memories failed: ${responseText}`);
  }

  logger.debug({ userId, textLength: text.length }, 'Stored memory (local)');
}

export interface LocalMem0Memory {
  id: string;
  memory: string;
  user_id: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export async function localSearchMemories(
  query: string,
  userId: string,
): Promise<LocalMem0Memory[]> {
  const conn = await getConnection(userId);
  const result = await conn.client.callTool({
    name: 'search_memory',
    arguments: { query },
  });

  const content = result.content as Array<{ type: string; text?: string }>;
  const responseText = content?.find((c) => c.type === 'text')?.text || '';

  if (responseText.startsWith('Error:') || !responseText) {
    return [];
  }

  try {
    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed)) {
      return parsed.map(
        (m: {
          id?: string;
          memory?: string;
          text?: string;
          created_at?: string;
          metadata?: Record<string, unknown>;
        }) => ({
          id: m.id || '',
          memory: m.memory || m.text || '',
          user_id: userId,
          metadata: m.metadata,
          created_at: m.created_at,
        }),
      );
    }
    return [];
  } catch {
    return [];
  }
}

export async function localDeleteMemoriesByUser(userId: string): Promise<void> {
  const conn = await getConnection(userId);
  const result = await conn.client.callTool({
    name: 'delete_all_memories',
    arguments: {},
  });

  const content = result.content as Array<{ type: string; text?: string }>;
  const responseText = content?.find((c) => c.type === 'text')?.text || '';

  if (responseText.startsWith('Error:')) {
    logger.warn(
      { userId, response: responseText },
      'Failed to delete memories (local)',
    );
  }
}

export async function closeLocalMem0(): Promise<void> {
  for (const [userId, conn] of connections) {
    try {
      await conn.client.close();
    } catch (err) {
      logger.debug({ userId, err }, 'Error closing MCP connection');
    }
  }
  connections.clear();
}
