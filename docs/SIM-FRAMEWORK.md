# Integration Sim Framework

27 scenarios that test the bot end-to-end: real Docker containers, real Mem0, real extraction — only Telegram is swapped for a SimChannel.

## How It Works

The sim runner (`tests/integration/sim-runner.ts`) boots the full agent system via `main()` from `src/index.ts` with `SIM_MODE=1`. This activates the SimChannel instead of Telegram. Messages are drip-fed with synthetic timestamps, then assertions check the results.

```
SimChannel (replaces Telegram I/O)
  ↓
Same index.ts main() loop
  ↓
Real Docker containers, real Mem0, real extraction, real IPC
  ↓
Assertions check: memory exists, response contains, response avoids, etc.
```

## Running Sims

```bash
# Single scenario
SIM_MODE=1 npx tsx tests/integration/sim-runner.ts slash-hello-recall

# All 27 scenarios (~100 minutes)
./tests/integration/run-all.sh

# With verbose output (see agent responses)
SIM_MODE=1 VERBOSE=1 npx tsx tests/integration/sim-runner.ts daily-digest
```

**Requirements:** Docker running, `ANTHROPIC_API_KEY` and `MEM0_API_KEY` set.

**Do not run two scenarios in parallel.** They share port 3001 (credential proxy) and the SQLite database.

## Scenario Format

Scenarios live at `../sim/scenarios/*.json` (relative to the agent repo). JSON format:

```json
{
  "name": "Human-readable name",
  "description": "What this tests",
  "tests": ["Test 1 description", "Test 2"],
  "personas": [
    {"id": "bootstrapper", "name": "Jordan", "role": "crew", "joins_day": 1},
    {"id": "member1", "name": "Maria", "role": "member", "joins_day": 1}
  ],
  "days": [
    {
      "day": 1,
      "messages": [
        {"from": "member1", "context": "group", "text": "/hello I'm Maria..."},
        {"from": "member1", "context": "dm", "text": "Can you help me?"}
      ]
    }
  ],
  "triggers": [
    {"after_day": 1, "from": "member2", "context": "group", "text": "@Bot who is Maria?"}
  ],
  "assertions": [
    {"after_day": 1, "type": "memory_exists", "value": "maria"},
    {"after_day": 1, "type": "response_contains_any", "value": ["photographer", "photography"]},
    {"after_day": 1, "type": "response_avoids", "value": "private information"}
  ],
  "setup_files": {
    "data/escalations/sim-test/2026-09-01.json": "{\"text\": \"noise concern\", \"severity\": \"medium\"}"
  }
}
```

**Messages** are sent without triggering the bot (context accumulation). **Triggers** are sent and the bot's response is captured. **Assertions** check the result.

**`setup_files`** pre-places files before the scenario runs. Useful for testing pipelines (e.g., "does crew digest read escalation files?") without requiring the agent to generate them in the same scenario.

## Assertion Types

| Type | Count | What it checks |
|------|-------|---------------|
| `response_contains_any` | 45 | Response includes at least one of several synonyms |
| `memory_exists` | 44 | Mem0 has a memory matching a keyword |
| `response_avoids` | 30 | Response does NOT contain a phrase |
| `custom` | 29 | Custom JS assertion function |
| `response_contains` | 16 | Response includes exact phrase |
| `judge` | 16 | LLM judges whether response meets a criterion |
| `memory_absent` | 7 | Mem0 does NOT have a matching memory |
| `tier_correct` | 3 | Memory is stored with correct tier metadata |
| `epistemic_marker` | 2 | Response uses attribution ("X mentioned...") |
| `escalation_exists` | 1 | Escalation file was written to disk |
| `escalation_avoids` | 1 | Escalation file doesn't contain identifying info |
| `dm_received` | 1 | A DM was sent to a specific user |

Total: 195 assertions across 27 scenarios. Current pass rate: 192/195 (3 are LLM phrasing variance, not bugs).

## Scenarios by Category

**Slash commands:** slash-hello-recall, slash-today-where, slash-connect, slash-forget, slash-natural-language

**Memory & extraction:** extraction-cross-batch, extraction-patterns, operational-history, temporal-decay, conflicting-information

**Behavioral:** listening-mode, tag-only-silence, pattern-sensing, first-person-authority, practiced-norm-gap, stress-event-changes

**Privacy & security:** privacy-wall, memory-poisoning, prompt-injection, social-engineering, escalation-anonymity

**Phase C features:** daily-digest, crew-digest, subscribe-notify, crew-authority

**DM:** dm-intro-search

**Bootstrap:** week-1-bootstrap

## Gotchas

1. **Persisted demo groups interfere.** `cleanupSimData()` only clears `sim:*` DB rows. The demo group `emergentvibe-demo` persists in `data/state.json` and can be grabbed by code that does "find first main group."

2. **LLM phrasing variance is inevitable.** Use `response_contains_any` with synonym arrays (`["several", "multiple", "a few"]`), not exact phrases. Expect ~1-2% flakiness.

3. **Pre-placed fixtures are legitimate.** `setup_files` tests the pipeline, not the agent's file-writing. Testing "does crew digest read escalation files" doesn't require generating those files from scratch.

4. **Build the container after template changes.** The agent-runner reads templates from inside the Docker image. `./container/build.sh` after changing `governance/templates/`.

5. **Sim/production JID format differs.** Telegram: sender ID = chat ID. Sim: `sim:*` JIDs. Subscriptions storing `chatJid` need the correct format for the environment.
