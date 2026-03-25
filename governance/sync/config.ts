export interface GroupConfig {
  folder: string;
  slug: string;
  community_name: string;
  polis_url?: string;
  admin_id?: string;
  admin_name?: string;
  community_start_date?: string;
  /** Controls which building blocks are active. Defaults to 'memory-only'. */
  governance_mode?: 'memory-only' | 'full';
}

export interface SyncConfig {
  apiUrl: string;
  syncIntervalMs: number;
  groups: GroupConfig[];
}

export function loadConfig(): SyncConfig {
  const apiUrl = process.env.EMERGENTVIBE_API_URL || 'https://emergentvibe.com';
  const syncIntervalMs = parseInt(process.env.SYNC_INTERVAL_MS || '300000', 10);

  let groups: GroupConfig[] = [];
  try {
    groups = JSON.parse(process.env.GROUPS_CONFIG || '[]');
  } catch {
    console.error('Failed to parse GROUPS_CONFIG, using empty array');
  }

  return { apiUrl, syncIntervalMs, groups };
}
