import * as fs from 'fs';
import * as path from 'path';
import type { GroupConfig } from './config.js';
import {
  loadFeatureConfig,
  stripDisabledFeatures,
} from '../../src/feature-config.js';

export interface ConstitutionData {
  slug: string;
  name: string;
  content: string;
  version: string;
  content_hash: string | null;
  updated_at: string;
}

export function loadTemplate(templateDir?: string): string {
  const dir = templateDir ?? path.resolve(import.meta.dirname ?? '.', '../templates');
  const base = fs.readFileSync(path.join(dir, 'base-template.md'), 'utf-8');
  const group = fs.readFileSync(path.join(dir, 'group-template.md'), 'utf-8');
  return base + '\n\n' + group;
}

function readCrewNames(groupFolder: string, basePath?: string): string | null {
  const crewPath = path.join(basePath || process.cwd(), 'groups', groupFolder, 'crew.json');
  try {
    if (!fs.existsSync(crewPath)) return null;
    const raw = JSON.parse(fs.readFileSync(crewPath, 'utf-8'));
    const members: Array<{ name: string }> = Array.isArray(raw) ? raw : raw.members || [];
    if (members.length === 0) return null;
    return members.map((m) => m.name).join(', ');
  } catch {
    return null;
  }
}

export function buildClaudeMd(template: string, group: GroupConfig, data: ConstitutionData, _apiUrl?: string, basePath?: string): string {
  const crewList = readCrewNames(group.folder, basePath) || 'the crew';
  const assistantName = process.env.ASSISTANT_NAME || 'Andy';

  const features = loadFeatureConfig(group.folder);
  const stripped = stripDisabledFeatures(template, features);

  return stripped
    .replace(/\{\{community_name\}\}/g, group.community_name)
    .replace(/\{\{crew_list\}\}/g, crewList)
    .replace(/\{\{assistant_name\}\}/g, assistantName)
    .replace(/\{\{admin_id\}\}/g, group.admin_id || 'unknown')
    .replace(/\{\{admin_name\}\}/g, group.admin_name || 'the bootstrapper')
    .replace(/\{\{community_start_date\}\}/g, group.community_start_date || new Date().toISOString().split('T')[0])
    .replace(/\{\{slug\}\}/g, data.slug)
    .replace(/\{\{[a-z_]+\}\}/g, '(Not configured)');
}
