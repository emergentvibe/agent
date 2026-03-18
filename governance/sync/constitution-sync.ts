import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, GroupConfig } from './config';

interface ConstitutionData {
  slug: string;
  name: string;
  content: string;
  version: string;
  content_hash: string | null;
  updated_at: string;
}

// Cache of last-seen versions per group
const versionCache = new Map<string, string>();

async function fetchConstitution(apiUrl: string, slug: string): Promise<ConstitutionData | null> {
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

function loadTemplate(): string {
  const templatePath = path.resolve(__dirname, '../templates/claude-md-template.md');
  return fs.readFileSync(templatePath, 'utf-8');
}

function buildClaudeMd(template: string, group: GroupConfig, data: ConstitutionData, apiUrl: string): string {
  return template
    .replace(/\{\{community_name\}\}/g, group.community_name)
    .replace(/\{\{principles_version\}\}/g, data.version)
    .replace(/\{\{principles_hash\}\}/g, data.content_hash || 'unknown')
    .replace(/\{\{principles_updated_at\}\}/g, data.updated_at)
    .replace(/\{\{principles_content\}\}/g, data.content)
    .replace(/\{\{charter_content\}\}/g, '(No behavioral charter configured yet)')
    .replace(/\{\{charter_updated_at\}\}/g, 'N/A')
    .replace(/\{\{emergentvibe_url\}\}/g, apiUrl)
    .replace(/\{\{slug\}\}/g, data.slug)
    .replace(/\{\{polis_url\}\}/g, group.polis_url || `${apiUrl}/c/${data.slug}/polis`);
}

async function syncGroup(group: GroupConfig, apiUrl: string): Promise<void> {
  const data = await fetchConstitution(apiUrl, group.slug);
  if (!data) return;

  const cacheKey = `${group.folder}:${group.slug}`;
  const cached = versionCache.get(cacheKey);
  const current = `${data.version}:${data.content_hash}`;

  if (cached === current) {
    return; // No changes
  }

  const template = loadTemplate();
  const claudeMd = buildClaudeMd(template, group, data, apiUrl);

  const groupDir = path.resolve(process.cwd(), 'groups', group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const outputPath = path.join(groupDir, 'CLAUDE.md');
  fs.writeFileSync(outputPath, claudeMd, 'utf-8');

  versionCache.set(cacheKey, current);
  console.log(`[sync] Updated ${group.folder} — version ${data.version}`);
}

async function syncAll(): Promise<void> {
  const config = loadConfig();
  console.log(`[sync] Syncing ${config.groups.length} groups from ${config.apiUrl}`);

  for (const group of config.groups) {
    await syncGroup(group, config.apiUrl);
  }
}

// Run once or on interval
async function main() {
  const config = loadConfig();

  await syncAll();

  if (config.syncIntervalMs > 0) {
    console.log(`[sync] Polling every ${config.syncIntervalMs / 1000}s`);
    setInterval(syncAll, config.syncIntervalMs);
  }
}

main().catch(console.error);
