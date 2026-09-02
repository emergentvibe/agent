# NanoClaw — Community Intelligence Bot

## What This Is

A bot that serves as shared memory and connective tissue for real-world communities. People in a coliving space, a gathering, a residency can ask it about the wifi password, today's schedule, who else is into music. It reads every message but mostly stays quiet. When it speaks, it's brief, warm, and honest about what it knows and doesn't know.

This is a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) (a personal Claude assistant) customized with a community intelligence layer: governance templates, Mem0-based shared memory, a triage classifier, knowledge seeding, and a simulation framework for testing behavioral design.

## Design Principles

When making a decision, these are the priorities in order:

1. **Privacy over features.** If a feature risks leaking personal information, don't build it. A user sharing something in a DM must never have that appear in the group or in another user's context. When in doubt, don't store it.

2. **Silence over noise.** The bot's default state is silence. It reads everything, speaks rarely. A bot that talks too much is worse than one that talks too little. Err toward staying quiet.

3. **Simple over clever.** File-based IPC over pubsub. One Mem0 namespace over complex namespace routing. Session compaction over a personal memory system. This runs for a week for 40 people, not at enterprise scale. Complexity is the enemy.

4. **Honest over helpful.** The bot should say "I don't know" rather than guess. It should attribute sources ("Alex mentioned...") rather than state things as fact. It should surface disagreements rather than resolve them.

5. **Infrastructure over participant.** The bot is not a community member. It doesn't have opinions, doesn't take sides, doesn't manufacture engagement. It's more like a village notice board that can talk.

## Architecture

Single Node.js process with skill-based channel system. Channels (Telegram currently) self-register at startup. Messages route to Claude Agent SDK running in ephemeral Docker containers. Each group has isolated filesystem and memory. Community knowledge lives in Mem0 under a single shared namespace — no personal namespaces. DM containers can search Mem0 but never write to it (enforced by `allowedTools` in agent-runner).

A background extraction loop (`src/extraction.ts`) runs every 5 minutes, using Haiku to process group messages and store facts, introductions, wishes, patterns, and concerns to Mem0. `MIN_CONTEXT_MESSAGES=20` ensures cross-batch context even when messages are spaced far apart.

Per-group feature flags (`src/feature-config.ts`) control which commands and behaviors are active. Phase C features (escalation, crew digest, subscriptions) default to off and are enabled via `groups/{name}/features.json`.

The community intelligence layer is ours (`governance/`, `knowledge/`, `src/triage.ts`, `src/mem0-client.ts`, `src/seed.ts`, `src/dm-registration.ts`, `src/extraction.ts`, `src/feature-config.ts`, `src/crew.ts`, `src/digest.ts`, `src/subscriptions.ts`). The runtime (IPC, containers, queue, routing) is upstream NanoClaw.

There's a 27-scenario integration sim framework (`tests/integration/sim-runner.ts` + `../sim/scenarios/`) that replaces Telegram with a SimChannel but runs everything else as production code — Docker, Mem0, extraction, IPC.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher, task processing, escalation storage |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/extraction.ts` | Background memory extraction loop (Haiku) |
| `src/feature-config.ts` | Per-group feature flags (commands + behaviors) |
| `src/crew.ts` | Crew member management |
| `src/digest.ts` | Daily and crew digest generation |
| `src/subscriptions.ts` | Topic subscription + extraction-driven notification |
| `src/dm-registration.ts` | DM auto-registration + community lookup |
| `src/triage.ts` | Message triage classifier (Haiku) |
| `src/mem0-client.ts` | Mem0 HTTP client |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group agent instructions (isolated) |
| `groups/{name}/features.json` | Per-group feature toggles |
| `tests/integration/sim-runner.ts` | 27-scenario integration sim runner |
| `container/agent-runner/src/index.ts` | Agent runner inside Docker (tool filtering, IPC) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run unit tests (501 pass, 17 pre-existing failures)
./container/build.sh # Rebuild agent container

# Integration sims (requires Docker + ANTHROPIC_API_KEY + MEM0_API_KEY)
SIM_MODE=1 npx tsx tests/integration/sim-runner.ts <scenario-name>
./tests/integration/run-all.sh  # all 27 scenarios (~100 min)
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
