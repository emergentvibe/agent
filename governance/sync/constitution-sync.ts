import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, GroupConfig } from './config.js';

export interface ConstitutionData {
  slug: string;
  name: string;
  content: string;
  version: string;
  content_hash: string | null;
  updated_at: string;
}

// Cache of last-seen versions per group
const versionCache = new Map<string, string>();

/** @internal Exported for testing */
export function _clearVersionCache(): void {
  versionCache.clear();
}

export async function fetchConstitution(apiUrl: string, slug: string): Promise<ConstitutionData | null> {
  try {
    const res = await fetch(`${apiUrl}/api/constitution/${slug}`);
    if (!res.ok) {
      console.error(`Failed to fetch constitution ${slug}: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`Error fetching constitution ${slug}:`, err);
    return null;
  }
}

export async function sendHeartbeat(apiUrl: string, slug: string, constitutionVersion: string): Promise<void> {
  const botSecret = process.env.BOT_API_SECRET;
  if (!botSecret) return;

  try {
    await fetch(`${apiUrl}/api/constitution/${slug}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': botSecret,
      },
      body: JSON.stringify({
        constitution_version: constitutionVersion,
        status: 'ok',
      }),
    });
  } catch (err) {
    console.error(`Heartbeat failed for ${slug}:`, err);
  }
}

export function loadTemplate(templateDir?: string): string {
  const templatePath = templateDir
    ? path.join(templateDir, 'claude-md-template.md')
    : path.resolve(import.meta.dirname ?? '.', '../templates/claude-md-template.md');
  return fs.readFileSync(templatePath, 'utf-8');
}

export function buildClaudeMd(template: string, group: GroupConfig, data: ConstitutionData, apiUrl: string): string {
  return template
    .replace(/\{\{community_name\}\}/g, group.community_name)
    .replace(/\{\{admin_id\}\}/g, group.admin_id || 'unknown')
    .replace(/\{\{admin_name\}\}/g, group.admin_name || 'the admin')
    .replace(/\{\{principles_version\}\}/g, data.version)
    .replace(/\{\{principles_hash\}\}/g, data.content_hash || 'unknown')
    .replace(/\{\{principles_updated_at\}\}/g, data.updated_at)
    .replace(/\{\{principles_content\}\}/g, data.content)
    .replace(/\{\{charter_content\}\}/g, '(No behavioral charter configured yet)')
    .replace(/\{\{charter_updated_at\}\}/g, 'N/A')
    .replace(/\{\{emergentvibe_url\}\}/g, apiUrl)
    .replace(/\{\{slug\}\}/g, data.slug)
    .replace(/\{\{last_sync_time\}\}/g, new Date().toISOString())
    .replace(/\{\{polis_url\}\}/g, group.polis_url || `${apiUrl}/c/${data.slug}/polis`);
}

export async function syncGroup(group: GroupConfig, apiUrl: string, basePath?: string): Promise<void> {
  const data = await fetchConstitution(apiUrl, group.slug);
  const base = basePath || process.cwd();

  if (!data) {
    const outputPath = path.join(base, 'groups', group.folder, 'CLAUDE.md');
    if (fs.existsSync(outputPath)) {
      console.log(`[sync] API unavailable for ${group.slug}, using cached CLAUDE.md`);
    } else {
      console.error(`[sync] API unavailable for ${group.slug} and no cached CLAUDE.md`);
    }
    return;
  }

  const cacheKey = `${group.folder}:${group.slug}`;
  const cached = versionCache.get(cacheKey);
  const current = `${data.version}:${data.content_hash}`;

  if (cached === current) {
    await sendHeartbeat(apiUrl, group.slug, data.version);
    return;
  }

  const template = loadTemplate();
  const claudeMd = buildClaudeMd(template, group, data, apiUrl);

  const groupDir = path.resolve(base, 'groups', group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const outputPath = path.join(groupDir, 'CLAUDE.md');
  fs.writeFileSync(outputPath, claudeMd, 'utf-8');

  versionCache.set(cacheKey, current);
  console.log(`[sync] Updated ${group.folder} — version ${data.version}`);

  await sendHeartbeat(apiUrl, group.slug, data.version);
}

export async function syncAll(): Promise<void> {
  const config = loadConfig();
  console.log(`[sync] Syncing ${config.groups.length} groups from ${config.apiUrl}`);

  for (const group of config.groups) {
    await syncGroup(group, config.apiUrl);
  }
}

// Run as script when executed directly
const isMain = process.argv[1]?.endsWith('constitution-sync.js') || process.argv[1]?.endsWith('constitution-sync.ts');
if (isMain) {
  (async () => {
    const config = loadConfig();
    await syncAll();
    if (config.syncIntervalMs > 0) {
      console.log(`[sync] Polling every ${config.syncIntervalMs / 1000}s`);
      setInterval(syncAll, config.syncIntervalMs);
    }
  })().catch(console.error);
}
