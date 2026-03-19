#!/usr/bin/env npx tsx
/**
 * Mock bot: Manual e2e test harness.
 *
 * Simulates a NanoClaw agent session WITHOUT Docker or Telegram.
 * Pipes ContainerInput JSON to the agent-runner's stdin and reads
 * output markers from stdout.
 *
 * Usage:
 *   # Start platform dev server first:
 *   cd ../constitution && npm run dev
 *
 *   # Then run mock bot (needs ANTHROPIC_API_KEY or Claude subscription):
 *   EMERGENTVIBE_API_URL=http://localhost:3000 \
 *   BOT_API_SECRET=your-secret \
 *   npx tsx tests/e2e/mock-bot.ts
 *
 * What it does:
 *   1. Runs constitution sync (fetches from platform, builds CLAUDE.md)
 *   2. Launches agent-runner with a test message
 *   3. Streams agent output to console
 *   4. Accepts follow-up messages via stdin (interactive mode)
 *
 * Without Claude auth, use --dry-run to just test sync + CLAUDE.md generation.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(__dirname, '../..');

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

// ── Config ────────────────────────────────────────────────────

const API_URL = process.env.EMERGENTVIBE_API_URL || 'http://localhost:3000';
const BOT_SECRET = process.env.BOT_API_SECRET || '';
const GROUP_SLUG = process.env.GROUP_SLUG || 'edge-esmeralda';
const GROUP_FOLDER = process.env.GROUP_FOLDER || 'telegram_edge';
const COMMUNITY_NAME = process.env.COMMUNITY_NAME || 'Edge Esmeralda';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Sync constitution ─────────────────────────────────────────

async function syncConstitution(): Promise<boolean> {
  console.log(`\n[mock-bot] Fetching constitution from ${API_URL}/api/constitution/${GROUP_SLUG}`);

  try {
    const res = await fetch(`${API_URL}/api/constitution/${GROUP_SLUG}`);
    if (!res.ok) {
      console.error(`[mock-bot] Constitution fetch failed: ${res.status}`);
      return false;
    }

    const data = await res.json();
    console.log(`[mock-bot] Got constitution: "${data.name}" v${data.version} (hash: ${data.content_hash})`);

    // Build CLAUDE.md from template
    const templatePath = path.join(AGENT_ROOT, 'governance/templates/claude-md-template.md');
    const template = fs.readFileSync(templatePath, 'utf-8');

    const claudeMd = template
      .replace(/\{\{community_name\}\}/g, COMMUNITY_NAME)
      .replace(/\{\{principles_version\}\}/g, data.version)
      .replace(/\{\{principles_hash\}\}/g, data.content_hash || 'unknown')
      .replace(/\{\{principles_updated_at\}\}/g, data.updated_at)
      .replace(/\{\{principles_content\}\}/g, data.content)
      .replace(/\{\{charter_content\}\}/g, '(No behavioral charter configured yet)')
      .replace(/\{\{charter_updated_at\}\}/g, 'N/A')
      .replace(/\{\{emergentvibe_url\}\}/g, API_URL)
      .replace(/\{\{slug\}\}/g, data.slug)
      .replace(/\{\{last_sync_time\}\}/g, new Date().toISOString())
      .replace(/\{\{polis_url\}\}/g, `${API_URL}/c/${data.slug}/polis`);

    // Write CLAUDE.md to a temp workspace
    const workspaceDir = path.join(AGENT_ROOT, 'tests/e2e/.workspace', GROUP_FOLDER);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), claudeMd);

    console.log(`[mock-bot] CLAUDE.md written to ${workspaceDir}/CLAUDE.md`);
    console.log(`[mock-bot] Constitution content: ${data.content.slice(0, 200)}...`);

    // Check for unreplaced placeholders
    const unreplaced = claudeMd.match(/\{\{[^}]+\}\}/g);
    if (unreplaced) {
      console.error(`[mock-bot] WARNING: Unreplaced placeholders: ${unreplaced.join(', ')}`);
    } else {
      console.log('[mock-bot] All template placeholders replaced successfully');
    }

    return true;
  } catch (err) {
    console.error(`[mock-bot] Sync error:`, err);
    return false;
  }
}

// ── Send heartbeat ────────────────────────────────────────────

async function sendHeartbeat(version: string): Promise<void> {
  if (!BOT_SECRET) {
    console.log('[mock-bot] No BOT_API_SECRET, skipping heartbeat');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/constitution/${GROUP_SLUG}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': BOT_SECRET },
      body: JSON.stringify({ constitution_version: version, agent_version: 'mock-bot-1.0', status: 'ok' }),
    });
    console.log(`[mock-bot] Heartbeat: ${res.status}`);
  } catch {
    console.log('[mock-bot] Heartbeat failed (non-fatal)');
  }
}

// ── Format message as XML ─────────────────────────────────────

function formatMessage(sender: string, senderId: string, content: string): string {
  const now = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  return `<context timezone="UTC" />
<messages>
<message sender="${sender}" sender_id="${senderId}" time="${now}">${content}</message>
</messages>`;
}

// ── Run agent ─────────────────────────────────────────────────

async function runAgent(message: string): Promise<void> {
  const workspaceDir = path.join(AGENT_ROOT, 'tests/e2e/.workspace', GROUP_FOLDER);

  const input: ContainerInput = {
    prompt: formatMessage('TestUser', 'tg-12345', message),
    groupFolder: GROUP_FOLDER,
    chatJid: 'mock-chat-123',
    isMain: false,
    assistantName: `${COMMUNITY_NAME} Bot`,
    ...(process.env.MEM0_API_KEY ? {
      mcpServers: {
        mem0: {
          command: 'uvx',
          args: ['mem0-mcp-server'],
          env: { MEM0_API_KEY: process.env.MEM0_API_KEY },
        },
      },
    } : {}),
  };

  console.log('\n[mock-bot] Sending to agent-runner:');
  console.log(`  prompt: "${message}"`);
  console.log(`  groupFolder: ${input.groupFolder}`);
  console.log(`  mcpServers: ${Object.keys(input.mcpServers || {}).join(', ') || 'none'}`);

  // The agent-runner expects to run from /workspace/group with CLAUDE.md there
  // In production, Docker mounts the group folder. Here we just set CWD.
  const agentRunner = path.join(AGENT_ROOT, 'container/agent-runner/src/index.ts');

  const child = spawn('npx', ['tsx', agentRunner], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      // Agent-runner needs these
      NODE_OPTIONS: '--experimental-vm-modules',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Pipe input
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();

  // Collect output
  let stdout = '';
  let inOutput = false;

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      if (line.includes(OUTPUT_START)) {
        inOutput = true;
        continue;
      }
      if (line.includes(OUTPUT_END)) {
        inOutput = false;
        continue;
      }
      if (inOutput) {
        try {
          const output = JSON.parse(line);
          console.log(`\n[agent] ${output.status}: ${output.result}`);
        } catch {
          stdout += line;
        }
      }
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    // Filter agent-runner logs
    for (const line of text.split('\n')) {
      if (line.trim()) console.log(`  [agent-log] ${line.trim()}`);
    }
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      console.log(`\n[mock-bot] Agent exited with code ${code}`);
      resolve();
    });
  });
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('=== Mock Bot E2E Test Harness ===');
  console.log(`API: ${API_URL}`);
  console.log(`Group: ${GROUP_SLUG} (${GROUP_FOLDER})`);
  console.log(`Bot secret: ${BOT_SECRET ? 'set' : 'NOT SET'}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log();

  // Step 1: Sync constitution
  const synced = await syncConstitution();
  if (!synced) {
    console.error('\n[mock-bot] Constitution sync failed. Is the platform running?');
    console.log('  Start it with: cd ../constitution && npm run dev');
    process.exit(1);
  }

  // Step 2: Send heartbeat
  await sendHeartbeat('mock');

  if (DRY_RUN) {
    console.log('\n[mock-bot] Dry run complete. CLAUDE.md generated successfully.');
    console.log('[mock-bot] To run with agent, remove --dry-run (needs Claude auth).');
    process.exit(0);
  }

  // Step 3: Interactive mode
  console.log('\n[mock-bot] Interactive mode. Type messages to send to the agent.');
  console.log('[mock-bot] Commands: /quit, /sync, /heartbeat');
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    rl.question('You> ', async (input) => {
      if (!input.trim()) { prompt(); return; }

      if (input === '/quit') { rl.close(); process.exit(0); }
      if (input === '/sync') { await syncConstitution(); prompt(); return; }
      if (input === '/heartbeat') { await sendHeartbeat('mock'); prompt(); return; }

      await runAgent(input);
      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
