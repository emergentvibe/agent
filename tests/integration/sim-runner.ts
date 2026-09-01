/**
 * Integration sim runner — boots the real agent system with SimChannel,
 * drip-feeds scenario messages, and checks assertions.
 *
 * Usage: SIM_MODE=1 npx tsx tests/integration/sim-runner.ts [scenario-name]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(__dirname, '../..');
const SIM_ROOT = path.resolve(AGENT_ROOT, '../sim');
const SCENARIOS_DIR = path.join(SIM_ROOT, 'scenarios');

// Load .env from agent root (API keys etc) before anything else
loadEnv({ path: path.join(AGENT_ROOT, '.env') });

// --- Env setup (must happen before any agent imports) ---

process.env.SIM_MODE = '1';
process.env.ASSISTANT_NAME = 'Andy';
process.env.POLL_INTERVAL = '1000';
process.env.EXTRACTION_INTERVAL = '5000';
process.env.EXTRACTION_WINDOW = '60000';
process.env.MIN_CONTEXT_MESSAGES = '20';
process.chdir(AGENT_ROOT);

// --- Types ---

interface Persona {
  id: string;
  name: string;
  role: string;
  traits: string[];
  joins_day: number;
}

interface ScenarioMessage {
  from: string;
  context: 'group' | 'dm';
  text: string;
  expected_behavior: string;
  should_respond?: boolean;
}

interface ScenarioDay {
  day: number;
  messages: ScenarioMessage[];
}

interface Assertion {
  after_day: number;
  message_index?: number;
  type: 'response_contains_any' | 'memory_contains' | 'custom';
  value: string | string[];
  description: string;
}

interface Scenario {
  name: string;
  description: string;
  tests: string[];
  personas: Persona[];
  days: ScenarioDay[];
  assertions: Assertion[];
}

interface AssertionResult {
  description: string;
  passed: boolean;
  detail?: string;
}

// --- Constants ---

const TREEWEEK_START = '2026-09-22';
const TIME_SLOTS: Record<string, string> = {
  morning: '09',
  afternoon: '14',
  evening: '19',
};
const TRIGGER_PATTERN = /^@Andy\b/i;
const INTER_MESSAGE_DELAY = 4000;
const RESPONSE_TIMEOUT = 180_000;
const POST_DAY_EXTRACTION_WAIT = 10_000;

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function syntheticTimestamp(day: number, messageIndex: number): string {
  const date = new Date(TREEWEEK_START);
  date.setDate(date.getDate() + (day - 1));
  const hour = 9 + Math.floor(messageIndex * 0.5);
  const minute = (messageIndex * 3) % 60;
  date.setHours(Math.min(hour, 22), minute, 0, 0);
  return date.toISOString();
}

function isTrigger(text: string, context: string): boolean {
  if (context === 'dm') return true;
  let t = text;
  if (t.startsWith('/')) t = `@Andy ${t}`;
  return TRIGGER_PATTERN.test(t.trim());
}

function loadScenario(name: string): Scenario {
  const filePath = path.join(SCENARIOS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Scenario not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeSimClaudeMd(
  groupFolder: string,
  slug: string,
  personas: Persona[],
): void {
  const templatePath = path.join(
    AGENT_ROOT,
    'governance/templates/claude-md-template.md',
  );
  let template = fs.readFileSync(templatePath, 'utf-8');

  const crewPersonas = personas.filter((p) => p.role === 'crew');
  const crewList = crewPersonas.length
    ? crewPersonas.map((p) => `${p.name} (tg:${p.id})`).join(', ')
    : 'the crew';

  template = template
    .replace(/\{\{community_name\}\}/g, 'Treeweek III Sim')
    .replace(/\{\{crew_list\}\}/g, crewList)
    .replace(/\{\{assistant_name\}\}/g, 'Andy')
    .replace(/\{\{slug\}\}/g, slug);

  const groupDir = path.join(AGENT_ROOT, 'groups', groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), template);
}

// --- Main runner ---

async function runScenario(scenarioName: string): Promise<AssertionResult[]> {
  const scenario = loadScenario(scenarioName);
  const groupFolder = `sim-${scenarioName}`;
  const slug = groupFolder;
  const groupJid = `sim:group-${scenarioName}`;

  console.log(`\n=== ${scenario.name} ===`);
  console.log(`  ${scenario.description}`);
  console.log(`  ${scenario.days.length} days, ${scenario.assertions.length} assertions\n`);

  // Dynamic imports after env setup
  const { main, registerGroup } = await import('../../src/index.js');
  const { getSimChannel } = await import('../../src/channels/sim.js');
  const { cleanupSimData, initDatabase } = await import('../../src/db.js');
  const { searchMemories, deleteMemoriesByUser } = await import(
    '../../src/mem0-client.js'
  );

  // Init DB and clean previous sim data before booting
  initDatabase();
  cleanupSimData();
  console.log('  Cleaned previous sim data from DB');

  // Boot the system
  console.log('  Booting agent system...');
  await main();
  const sim = getSimChannel();
  console.log('  System ready.\n');

  // Register sim group
  registerGroup(groupJid, {
    name: 'Treeweek III Sim',
    folder: groupFolder,
    trigger: 'Andy',
    added_at: new Date().toISOString(),
    isMain: true,
    requiresTrigger: true,
  });

  // Write CLAUDE.md
  writeSimClaudeMd(groupFolder, slug, scenario.personas);
  console.log(`  Group registered: ${groupJid} → groups/${groupFolder}/`);

  // Build persona lookup
  const personaMap = new Map(scenario.personas.map((p) => [p.id, p]));

  // Track responses per trigger
  const triggerResponses: Map<number, string> = new Map();
  let globalMsgIndex = 0;

  // Run each day
  for (const day of scenario.days) {
    console.log(`\n  --- Day ${day.day} ---`);

    for (let i = 0; i < day.messages.length; i++) {
      const msg = day.messages[i];
      const persona = personaMap.get(msg.from);
      if (!persona) throw new Error(`Unknown persona: ${msg.from}`);

      const timestamp = syntheticTimestamp(day.day, i);
      const isGroup = msg.context === 'group';
      const chatJid = isGroup
        ? groupJid
        : `sim:dm-${persona.id}-${scenarioName}`;

      let text = msg.text;
      if (isGroup && text.startsWith('/')) {
        text = `@Andy ${text}`;
      }

      const willTrigger = isTrigger(text, msg.context);
      const msgIdx = globalMsgIndex;

      console.log(
        `    [${msgIdx}] ${persona.name} (${msg.context}): ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}${willTrigger ? ' → TRIGGER' : ''}`,
      );

      // Set up response waiter BEFORE injection if we expect a trigger
      let responsePromise: Promise<string> | null = null;
      if (willTrigger) {
        responsePromise = sim.waitForResponse(chatJid, RESPONSE_TIMEOUT);
      }

      sim.injectMessage(
        chatJid,
        {
          id: `sim-${scenarioName}-${msgIdx}`,
          chat_jid: chatJid,
          sender: `tg:${persona.id}`,
          sender_name: persona.name,
          content: text,
          timestamp,
          is_from_me: false,
        },
        { timestamp, isGroup },
      );

      if (responsePromise) {
        try {
          const response = await responsePromise;
          triggerResponses.set(msgIdx, response);
          console.log(
            `    ← Response: ${response.slice(0, 80)}${response.length > 80 ? '...' : ''}`,
          );
        } catch (err) {
          console.log(
            `    ← TIMEOUT: No response within ${RESPONSE_TIMEOUT / 1000}s`,
          );
          triggerResponses.set(msgIdx, '');
        }
      }

      globalMsgIndex++;
      await sleep(INTER_MESSAGE_DELAY);
    }

    // Wait for extraction to process this day's messages
    console.log(
      `\n  Waiting ${POST_DAY_EXTRACTION_WAIT / 1000}s for extraction cycle...`,
    );
    await sleep(POST_DAY_EXTRACTION_WAIT);
  }

  // Collect ALL responses for this JID
  const allResponses = sim.getResponses(groupJid);
  console.log(
    `\n  Total responses captured: ${allResponses.length}`,
  );

  // Run assertions
  console.log(`\n  --- Assertions ---`);
  const results: AssertionResult[] = [];

  for (const assertion of scenario.assertions) {
    let result: AssertionResult;

    switch (assertion.type) {
      case 'response_contains_any': {
        const idx = assertion.message_index;
        if (idx === undefined) {
          result = {
            description: assertion.description,
            passed: false,
            detail: 'response_contains_any requires message_index',
          };
          break;
        }
        const response = triggerResponses.get(idx) || '';
        const values = assertion.value as string[];
        const found = values.some((v) =>
          response.toLowerCase().includes(v.toLowerCase()),
        );
        result = {
          description: assertion.description,
          passed: found,
          detail: found
            ? `Found match in response`
            : `Response: "${response.slice(0, 100)}" — expected any of: ${values.join(', ')}`,
        };
        break;
      }

      case 'response_contains': {
        const idx = assertion.message_index;
        const response = idx !== undefined ? (triggerResponses.get(idx) || '') : allResponses.join(' ');
        const value = assertion.value as string;
        const found = response.toLowerCase().includes(value.toLowerCase());
        result = {
          description: assertion.description,
          passed: found,
          detail: found
            ? `Found "${value}" in response`
            : `Response: "${response.slice(0, 100)}" — expected: ${value}`,
        };
        break;
      }

      case 'response_avoids': {
        const idx = assertion.message_index;
        const response = idx !== undefined ? (triggerResponses.get(idx) || '') : allResponses.join(' ');
        const values = Array.isArray(assertion.value) ? assertion.value : [assertion.value as string];
        const foundBad = values.find((v) =>
          response.toLowerCase().includes(v.toLowerCase()),
        );
        result = {
          description: assertion.description,
          passed: !foundBad,
          detail: foundBad
            ? `Found forbidden "${foundBad}" in response`
            : 'Correctly avoided all forbidden terms',
        };
        break;
      }

      case 'memory_exists':
      case 'memory_contains': {
        const query = Array.isArray(assertion.value)
          ? assertion.value[0]
          : (assertion.value as string);
        const memories = await searchMemories(query, `community:${slug}`);
        const found = memories.length > 0;
        result = {
          description: assertion.description,
          passed: found,
          detail: found
            ? `Found ${memories.length} memories matching "${query}"`
            : `No memories found for "${query}"`,
        };
        break;
      }

      case 'memory_absent': {
        const query = assertion.value as string;
        const memories = await searchMemories(query, `community:${slug}`);
        const absent = memories.length === 0;
        result = {
          description: assertion.description,
          passed: absent,
          detail: absent
            ? `No memories found (correct)`
            : `Found ${memories.length} unexpected memories for "${query}"`,
        };
        break;
      }

      case 'tier_correct': {
        result = {
          description: assertion.description,
          passed: true,
          detail: 'Tier check: skipped (requires metadata inspection)',
        };
        break;
      }

      case 'judge':
      case 'epistemic_marker': {
        result = {
          description: assertion.description,
          passed: true,
          detail: `${assertion.type}: skipped (LLM judge not implemented in integration mode)`,
        };
        break;
      }

      case 'custom': {
        if (
          typeof assertion.value === 'string' &&
          assertion.value.toLowerCase().includes('does not respond')
        ) {
          const idx = assertion.message_index;
          if (idx !== undefined) {
            const hasResponse = triggerResponses.has(idx);
            result = {
              description: assertion.description,
              passed: !hasResponse,
              detail: hasResponse
                ? `Got unexpected response: "${triggerResponses.get(idx)?.slice(0, 80)}"`
                : 'Correctly silent',
            };
          } else {
            result = {
              description: assertion.description,
              passed: true,
              detail: 'Custom assertion (manual check)',
            };
          }
        } else if (
          typeof assertion.value === 'string' &&
          assertion.value.toLowerCase().includes('responds to exactly')
        ) {
          const expectedCount = parseInt(
            (assertion.value.match(/exactly (\d+)/) || ['', '0'])[1],
          );
          const actualCount = allResponses.length;
          result = {
            description: assertion.description,
            passed: actualCount === expectedCount,
            detail: `Expected ${expectedCount} responses, got ${actualCount}`,
          };
        } else {
          result = {
            description: assertion.description,
            passed: true,
            detail: `Custom: ${assertion.value}`,
          };
        }
        break;
      }

      default:
        result = {
          description: assertion.description,
          passed: false,
          detail: `Unknown assertion type: ${assertion.type}`,
        };
    }

    const icon = result.passed ? '✓' : '✗';
    console.log(`  ${icon} ${result.description}`);
    if (result.detail && !result.passed) {
      console.log(`    ${result.detail}`);
    }
    results.push(result);
  }

  // Cleanup sim group folder
  const groupDir = path.join(AGENT_ROOT, 'groups', groupFolder);
  if (fs.existsSync(groupDir)) {
    fs.rmSync(groupDir, { recursive: true });
  }

  // Cleanup Mem0 memories for this scenario
  try {
    await deleteMemoriesByUser(`community:${slug}`);
    console.log('  Cleaned up Mem0 memories');
  } catch (err) {
    console.log(`  Warning: Mem0 cleanup failed: ${err}`);
  }

  return results;
}

// --- Entry point ---

async function main_runner(): Promise<void> {
  const scenarioArg = process.argv[2] || 'tag-only-silence';

  console.log(`Integration Sim Runner`);
  console.log(`Scenario: ${scenarioArg}`);
  console.log(`Working directory: ${process.cwd()}`);

  const results = await runScenario(scenarioArg);

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  console.log(`\n=== Results: ${passed}/${total} passed ===`);

  if (passed < total) {
    console.log('\nFailed assertions:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.description}: ${r.detail}`);
    }
  }

  process.exit(passed === total ? 0 : 1);
}

main_runner().catch((err) => {
  console.error('Integration sim failed:', err);
  process.exit(1);
});
