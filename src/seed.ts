#!/usr/bin/env tsx
/**
 * Knowledge seeding script.
 *
 * Reads markdown files from a knowledge directory, chunks them into
 * discrete facts, and stores each as a Mem0 memory with metadata.
 *
 * Usage:
 *   npm run seed -- --community edge-esmeralda --source ./knowledge/edge-esmeralda/
 *   npm run seed -- --community edge-esmeralda --source ./knowledge/edge-esmeralda/ --dry-run
 *   npm run seed -- --community edge-esmeralda --list   # show existing memories
 *   npm run seed -- --community edge-esmeralda --clear  # delete all seeded memories
 */

import fs from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';

const MEM0_API_URL = 'https://api.mem0.ai/v1';

// ── Types ──────────────────────────────────────────────────────────

interface MemoryChunk {
  text: string;
  metadata: {
    type: string;
    topic: string;
    tier: string;
    source_context: string;
    source_file: string;
    // Enhanced v2 fields (optional)
    event_id?: string;
    day_of_week?: string;
    time?: string;
    location?: string;
    recurrence?: string;
    person_name?: string;
  };
}

interface SeededMemory {
  id: string;
  memory: string;
  metadata?: Record<string, string>;
}

// ── Markdown Parsing ───────────────────────────────────────────────

/** Map filename to knowledge topic and type */
function fileToMeta(filename: string): {
  topic: string;
  type: string;
  tier: string;
} {
  const base = path.basename(filename, '.md').toLowerCase();
  const map: Record<string, { topic: string; type: string; tier: string }> = {
    spaces: { topic: 'spaces', type: 'fact', tier: 'operational' },
    events: { topic: 'events', type: 'fact', tier: 'operational' },
    food: { topic: 'meals', type: 'fact', tier: 'operational' },
    meals: { topic: 'meals', type: 'fact', tier: 'operational' },
    people: { topic: 'contacts', type: 'fact', tier: 'operational' },
    contacts: { topic: 'contacts', type: 'fact', tier: 'operational' },
    resources: { topic: 'resources', type: 'fact', tier: 'operational' },
    faq: { topic: 'logistics', type: 'fact', tier: 'operational' },
    logistics: { topic: 'logistics', type: 'fact', tier: 'operational' },
    welcome: { topic: 'welcome', type: 'fact', tier: 'operational' },
    norms: { topic: 'norms', type: 'norm', tier: 'social' },
    decisions: { topic: 'decisions', type: 'fact', tier: 'constitutional' },
    schedule: { topic: 'events', type: 'fact', tier: 'operational' },
    introductions: {
      topic: 'introductions',
      type: 'introduction',
      tier: 'social',
    },
  };
  return map[base] ?? { topic: base, type: 'fact', tier: 'operational' };
}

/**
 * Extract structured metadata from event text.
 * Looks for day-of-week, time patterns, and location indicators.
 */
export function parseEventMetadata(text: string): {
  day_of_week?: string;
  time?: string;
  location?: string;
  recurrence?: string;
} {
  const result: ReturnType<typeof parseEventMetadata> = {};

  // Day of week
  const dayMatch = text.match(
    /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b/i,
  );
  if (dayMatch)
    result.day_of_week =
      dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1).toLowerCase();

  // Time patterns: "7pm", "7:30pm", "7:30 PM", "19:00", "7-9pm", "7pm-9pm"
  const timeMatch = text.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))?|\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})\b/i,
  );
  if (timeMatch) result.time = timeMatch[1].trim();

  // Location: after "in" or "at" followed by a capitalized place name
  // Stop at sentence boundaries, time patterns, or parentheses
  const locMatch = text.match(
    /(?:(?:^|\s)(?:at|in)\s+(?:the\s+)?([A-Z][a-zA-Z\s]*?)(?:\s*[.,()\n]|\s+at\s+\d|\s+\d+(?::\d{2})?\s*(?:am|pm)|$))|Location:\s*([^\n,.)]+)/i,
  );
  if (locMatch) result.location = (locMatch[1] || locMatch[2]).trim();

  // Recurrence: "every", "daily", "weekly"
  const recurMatch = text.match(
    /\b(every\s+\w+|daily|weekly|bi-?weekly|monthly)\b/i,
  );
  if (recurMatch) result.recurrence = recurMatch[1].toLowerCase();

  return result;
}

/**
 * Parse a markdown file into discrete memory chunks.
 *
 * Strategy: split on blank lines. Each non-empty paragraph becomes
 * one memory. Headings are prepended as context to the following
 * paragraphs. Lines that are just headings or HTML comments are skipped.
 */
export function parseMarkdown(
  content: string,
  filename: string,
): MemoryChunk[] {
  const { topic, type, tier } = fileToMeta(filename);
  const lines = content.split('\n');
  const chunks: MemoryChunk[] = [];
  let currentHeading = '';
  let currentParagraph: string[] = [];

  const flush = () => {
    const text = currentParagraph.join(' ').replace(/\s+/g, ' ').trim();
    if (text && text.length > 5) {
      // Prepend heading context if we have one
      const fullText = currentHeading ? `${currentHeading}: ${text}` : text;
      const metadata: MemoryChunk['metadata'] = {
        type,
        topic,
        tier,
        source_context: 'seed',
        source_file: filename,
      };

      // Extract structured metadata for events
      if (topic === 'events') {
        const eventMeta = parseEventMetadata(fullText);
        if (eventMeta.day_of_week) metadata.day_of_week = eventMeta.day_of_week;
        if (eventMeta.time) metadata.time = eventMeta.time;
        if (eventMeta.location) metadata.location = eventMeta.location;
        if (eventMeta.recurrence) metadata.recurrence = eventMeta.recurrence;
      }

      chunks.push({ text: fullText, metadata });
    }
    currentParagraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip HTML comments (template placeholders)
    if (trimmed.startsWith('<!--') || trimmed.startsWith('-->')) continue;
    if (trimmed.startsWith('# ')) continue; // Skip document title

    // Section headings become context for following paragraphs
    if (/^#{2,4}\s+/.test(trimmed)) {
      flush();
      currentHeading = trimmed.replace(/^#{2,4}\s+/, '');
      continue;
    }

    // Blank line = paragraph boundary
    if (!trimmed) {
      flush();
      continue;
    }

    // List items: each becomes its own chunk (flush before and after)
    if (/^[-*•]\s+/.test(trimmed)) {
      flush(); // flush any preceding prose
      const cleaned = trimmed.replace(/^[-*•]\s+/, '');
      currentParagraph.push(cleaned);
      flush(); // emit this list item as its own chunk
      continue;
    }

    // Schedule-style lines ("Monday: ...", "Tuesday: ...") — each is its own chunk
    if (/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*:/i.test(trimmed)) {
      flush();
      currentParagraph.push(trimmed);
      flush();
      continue;
    }

    // Regular text — accumulate into paragraph
    currentParagraph.push(trimmed);
  }

  flush();
  return chunks;
}

// ── Mem0 API ───────────────────────────────────────────────────────

async function addMemory(
  apiKey: string,
  userId: string,
  text: string,
  metadata: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${MEM0_API_URL}/memories/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: text }],
      user_id: userId,
      metadata,
      infer: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mem0 add failed (${res.status}): ${body}`);
  }
}

async function listMemories(
  apiKey: string,
  userId: string,
): Promise<SeededMemory[]> {
  const res = await fetch(
    `${MEM0_API_URL}/memories/?user_id=${encodeURIComponent(userId)}`,
    {
      headers: { Authorization: `Token ${apiKey}` },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mem0 list failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return (data.results || data || []).map((r: any) => ({
    id: r.id,
    memory: r.memory,
    metadata: r.metadata,
  }));
}

async function deleteMemory(apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${MEM0_API_URL}/memories/${id}/`, {
    method: 'DELETE',
    headers: { Authorization: `Token ${apiKey}` },
  });
  if (!res.ok) {
    console.error(`  Failed to delete ${id}: ${res.status}`);
  }
}

async function searchMemories(
  apiKey: string,
  userId: string,
  query: string,
): Promise<SeededMemory[]> {
  const res = await fetch(`${MEM0_API_URL}/memories/search/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      user_id: userId,
      enable_graph: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mem0 search failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return (data.results || data || []).map((r: any) => ({
    id: r.id,
    memory: r.memory,
    metadata: r.metadata,
  }));
}

// ── CLI ────────────────────────────────────────────────────────────

function usage(): never {
  console.error(`
Usage:
  npm run seed -- --community <slug> --source <dir>   Seed knowledge from markdown files
  npm run seed -- --community <slug> --list            List existing memories
  npm run seed -- --community <slug> --search <query>  Search memories
  npm run seed -- --community <slug> --clear            Delete all memories for community
  npm run seed -- --community <slug> --source <dir> --dry-run   Show what would be seeded

Options:
  --community <slug>   Community slug (e.g., edge-esmeralda)
  --source <dir>       Directory containing markdown files
  --dry-run            Show chunks without storing
  --list               List all memories for the community
  --search <query>     Search memories
  --clear              Delete all memories (asks for confirmation)
`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  community: string;
  source?: string;
  dryRun: boolean;
  list: boolean;
  clear: boolean;
  search?: string;
} {
  const args = argv.slice(2);
  let community = '';
  let source: string | undefined;
  let dryRun = false;
  let list = false;
  let clear = false;
  let search: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--community':
        community = args[++i];
        break;
      case '--source':
        source = args[++i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--list':
        list = true;
        break;
      case '--clear':
        clear = true;
        break;
      case '--search':
        search = args[++i];
        break;
      default:
        console.error(`Unknown arg: ${args[i]}`);
        usage();
    }
  }

  if (!community) usage();
  return { community, source, dryRun, list, clear, search };
}

async function main() {
  const opts = parseArgs(process.argv);
  const userId = `community:${opts.community}`;

  // Get API key
  const apiKey =
    process.env.MEM0_API_KEY || readEnvFile(['MEM0_API_KEY']).MEM0_API_KEY;
  if (!apiKey) {
    console.error('MEM0_API_KEY not found in environment or .env file');
    process.exit(1);
  }

  // ── List ──
  if (opts.list) {
    console.log(`\nMemories for ${userId}:\n`);
    const memories = await listMemories(apiKey, userId);
    if (memories.length === 0) {
      console.log('  (none)');
    } else {
      for (const m of memories) {
        const meta = m.metadata
          ? ` [${m.metadata.type || '?'}/${m.metadata.topic || '?'}]`
          : '';
        console.log(`  • ${m.memory}${meta}`);
      }
      console.log(`\n  Total: ${memories.length} memories`);
    }
    return;
  }

  // ── Search ──
  if (opts.search) {
    console.log(`\nSearching ${userId} for "${opts.search}":\n`);
    const results = await searchMemories(apiKey, userId, opts.search);
    if (results.length === 0) {
      console.log('  No results.');
    } else {
      for (const m of results) {
        console.log(`  • ${m.memory}`);
      }
    }
    return;
  }

  // ── Clear ──
  if (opts.clear) {
    const memories = await listMemories(apiKey, userId);
    if (memories.length === 0) {
      console.log('No memories to clear.');
      return;
    }
    console.log(`Deleting ${memories.length} memories for ${userId}...`);
    for (const m of memories) {
      await deleteMemory(apiKey, m.id);
    }
    console.log('Done.');
    return;
  }

  // ── Seed ──
  if (!opts.source) usage();
  const sourceDir = path.resolve(opts.source);
  if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Read all markdown files
  const files = fs
    .readdirSync(sourceDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md');

  if (files.length === 0) {
    console.error(`No markdown files found in ${sourceDir}`);
    process.exit(1);
  }

  // Parse all files into chunks
  const allChunks: MemoryChunk[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(sourceDir, file), 'utf-8');
    const chunks = parseMarkdown(content, file);
    allChunks.push(...chunks);
    console.log(`  ${file}: ${chunks.length} chunks`);
  }

  console.log(
    `\nTotal: ${allChunks.length} memories from ${files.length} files`,
  );

  if (opts.dryRun) {
    console.log('\n── Dry Run ──\n');
    for (const chunk of allChunks) {
      console.log(
        `  [${chunk.metadata.type}/${chunk.metadata.topic}] ${chunk.text.slice(0, 120)}${chunk.text.length > 120 ? '...' : ''}`,
      );
    }
    console.log('\nNo memories were stored (dry run).');
    return;
  }

  // Store each chunk
  console.log(`\nSeeding ${allChunks.length} memories into ${userId}...\n`);
  let stored = 0;
  let failed = 0;
  for (const chunk of allChunks) {
    try {
      await addMemory(apiKey, userId, chunk.text, chunk.metadata);
      stored++;
      process.stdout.write(`  ${stored}/${allChunks.length}\r`);
    } catch (err) {
      failed++;
      console.error(`  Failed: ${chunk.text.slice(0, 80)}... — ${err}`);
    }
  }

  console.log(`\nDone. Stored: ${stored}, Failed: ${failed}`);

  // Verify with a sample search
  if (stored > 0) {
    console.log('\n── Verification ──');
    const sample = allChunks[0];
    const keyword = sample.metadata.topic;
    const results = await searchMemories(apiKey, userId, keyword);
    console.log(`  Search for "${keyword}": ${results.length} results`);
    if (results.length > 0) {
      console.log(`  Top result: ${results[0].memory}`);
    }
  }
}

// Only run CLI when executed directly (not imported by tests)
const isDirectRun =
  process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
