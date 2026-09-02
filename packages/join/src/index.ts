#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { fetchConstitution } from './fetch-constitution.js';
import { renderClaudeMd, validateRendered } from './render-claude-md.js';
import { configureMcp } from './configure-mcp.js';

const DEFAULT_API_URL = 'https://emergentvibe.com';
const TEMPLATE_PATH = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  '../../governance/templates/claude-code-template.md'
);

function usage(): never {
  console.error(`
Usage: npx @emergentvibe/join <slug> [options]

Join an emergentvibe community from Claude Code.

Arguments:
  slug                    Community slug (e.g., "edge-esmeralda")

Options:
  --mem0-url <url>        Mem0 SSE URL (e.g., http://localhost:8765/sse)
  --name <display-name>   Your display name in the community
  --api-url <url>         Platform API URL (default: ${DEFAULT_API_URL})
  --dir <path>            Target directory (default: current directory)
  --help                  Show this help message
`);
  process.exit(1);
}

function parseArgs(args: string[]): {
  slug: string;
  mem0Url: string;
  name: string;
  apiUrl: string;
  dir: string;
} {
  if (args.length < 1 || args[0] === '--help') usage();

  const slug = args[0];
  let mem0Url = '';
  let name = '';
  let apiUrl = DEFAULT_API_URL;
  let dir = process.cwd();

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--mem0-url':
        mem0Url = args[++i] || '';
        break;
      case '--name':
        name = args[++i] || '';
        break;
      case '--api-url':
        apiUrl = args[++i] || DEFAULT_API_URL;
        break;
      case '--dir':
        dir = args[++i] || process.cwd();
        break;
      case '--help':
        usage();
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        usage();
    }
  }

  if (!mem0Url) {
    console.error('Error: --mem0-url is required. Get it from your community operator.');
    process.exit(1);
  }
  if (!name) {
    console.error('Error: --name is required. This is your display name in the community.');
    process.exit(1);
  }

  return { slug, mem0Url, name, apiUrl, dir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Joining ${args.slug}...`);

  // 1. Fetch constitution
  console.log(`Fetching constitution from ${args.apiUrl}...`);
  const constitution = await fetchConstitution(args.apiUrl, args.slug);
  console.log(`Found: ${constitution.name} (v${constitution.version})`);

  // 2. Load and render template
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`Template not found at ${TEMPLATE_PATH}`);
    console.error('Make sure you have the agent repo checked out alongside this package.');
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const rendered = renderClaudeMd(template, {
    communityName: constitution.name,
    userName: args.name,
    adminId: 'unknown', // Will be set by operator
    adminName: 'the bootstrapper',
    communityStartDate: new Date().toISOString().split('T')[0],
    constitution,
    apiUrl: args.apiUrl,
    mem0Url: args.mem0Url,
  });

  // Validate no unreplaced placeholders
  const unreplaced = validateRendered(rendered);
  if (unreplaced.length > 0) {
    console.warn(`Warning: unreplaced template variables: ${unreplaced.join(', ')}`);
  }

  // 3. Write CLAUDE.md
  const claudeDir = path.join(args.dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const claudeMdPath = path.join(claudeDir, `community-${args.slug}.md`);
  fs.writeFileSync(claudeMdPath, rendered, 'utf-8');
  console.log(`Wrote community CLAUDE.md to ${claudeMdPath}`);

  // 4. Configure MCP
  configureMcp(args.dir, args.mem0Url);
  console.log(`Configured Mem0 MCP server (${args.mem0Url})`);

  // 5. Done
  console.log('');
  console.log(`You're connected to ${constitution.name}.`);
  console.log(`Your Claude Code instance can now access community memory as cc:${args.name}.`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart Claude Code for MCP changes to take effect');
  console.log('  2. Ask Claude about your community — it will search shared memory');
  console.log('  3. Share facts — Claude will store them in community memory');
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
