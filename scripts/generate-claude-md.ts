#!/usr/bin/env npx tsx
/**
 * Config-driven CLAUDE.md generator — builds group CLAUDE.md from templates
 * without needing the emergentvibe.com API.
 *
 * Usage: npx tsx scripts/generate-claude-md.ts <group-folder>
 *
 * Reads:
 *   groups/{folder}/group-config.json — community_name, slug, assistant_name, etc.
 *   groups/{folder}/features.json     — via loadFeatureConfig()
 *   groups/{folder}/crew.json         — crew names for {{crew_list}}
 *
 * Writes:
 *   groups/{folder}/CLAUDE.md
 */
import fs from 'fs';
import path from 'path';
import {
  loadFeatureConfig,
  stripDisabledFeatures,
} from '../src/feature-config.js';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: npx tsx scripts/generate-claude-md.ts <group-folder>');
  process.exit(1);
}

const groupDir = path.join(ROOT, 'groups', folder);
const configPath = path.join(groupDir, 'group-config.json');

if (!fs.existsSync(configPath)) {
  console.error(`Missing ${configPath}`);
  process.exit(1);
}

interface GroupConfig {
  community_name: string;
  slug: string;
  assistant_name?: string;
  admin_name?: string;
  community_start_date?: string;
}

const config: GroupConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Load templates
const templatesDir = path.join(ROOT, 'governance', 'templates');
const base = fs.readFileSync(
  path.join(templatesDir, 'base-template.md'),
  'utf-8',
);
const group = fs.readFileSync(
  path.join(templatesDir, 'group-template.md'),
  'utf-8',
);
let template = base + '\n\n' + group;

// Strip disabled features
const features = loadFeatureConfig(folder);
template = stripDisabledFeatures(template, features);

// Read crew names
function readCrewList(): string {
  const crewPath = path.join(groupDir, 'crew.json');
  try {
    if (!fs.existsSync(crewPath)) return 'the crew';
    const raw = JSON.parse(fs.readFileSync(crewPath, 'utf-8'));
    const members: Array<{ name: string }> = Array.isArray(raw)
      ? raw
      : raw.members || [];
    if (members.length === 0) return 'the crew';
    return members.map((m) => m.name).join(', ');
  } catch {
    return 'the crew';
  }
}

// Replace placeholders
const output = template
  .replace(/\{\{community_name\}\}/g, config.community_name)
  .replace(/\{\{slug\}\}/g, config.slug)
  .replace(
    /\{\{assistant_name\}\}/g,
    config.assistant_name || process.env.ASSISTANT_NAME || 'bot',
  )
  .replace(/\{\{crew_list\}\}/g, readCrewList())
  .replace(/\{\{admin_name\}\}/g, config.admin_name || 'the admin')
  .replace(
    /\{\{community_start_date\}\}/g,
    config.community_start_date || new Date().toISOString().split('T')[0],
  )
  .replace(/\{\{[a-z_]+\}\}/g, '(Not configured)');

// Write output
fs.mkdirSync(groupDir, { recursive: true });
const outputPath = path.join(groupDir, 'CLAUDE.md');
fs.writeFileSync(outputPath, output, 'utf-8');
console.log(`Generated ${outputPath}`);
console.log(
  `  Features: purchase=${features.commands.purchase}, rota=${features.commands.rota}, subscribe=${features.commands.subscribe}`,
);
