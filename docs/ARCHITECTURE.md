# Architecture

~11,600 lines of production TypeScript across 40 source files, plus ~970 lines of agent-runner code (across 2 files) that runs inside Docker containers. Single Node.js process on the host. One SQLite database. One vector database (Qdrant via OpenMemory). No microservices, no message queues.

---

## Structural Decomposition

### Layer 1: Channel I/O

Receives messages from the outside world and sends responses back.

| File | Lines | Role |
|------|-------|------|
| `src/channels/registry.ts` | 29 | Factory registry — channels self-register at module load |
| `src/channels/index.ts` | 16 | Barrel import that triggers registration |
| `src/channels/telegram.ts` | 1015 | Telegram Bot API: polling, commands, purchases, rota UI, inline keyboards, NFC deep links |
| `src/channels/sim.ts` | 108 | Test double — replaces Telegram in integration sims |

**Pattern:** Each channel file calls `registerChannel(name, factory)` at import time. The factory returns `null` if credentials are missing, so adding a channel never breaks boot. At startup, `index.ts` loops registered factories and connects the ones that return instances.

**Coupling:** Channels depend on `src/types.ts` (Channel interface) and receive callbacks (`onMessage`, `onChatMetadata`). They call `sendMessage` and `setTyping` on themselves. No channel knows about any other channel.

### Layer 2: Orchestration

The brain — message routing, container lifecycle, concurrency control.

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 1216 | Main loop: polls SQLite for new messages, decides whether to spawn containers, manages bot lifecycle |
| `src/router.ts` | 66 | Finds the channel that owns a JID, formats outbound messages |
| `src/group-queue.ts` | 365 | Per-group serial queue with global concurrency limit (`MAX_CONCURRENT_CONTAINERS`) |
| `src/config.ts` | 124 | Constants: paths, intervals, trigger pattern, container image |

**`index.ts` is the god object.** It owns:
- Registered group state (loaded from SQLite at boot)
- Message polling loop (30s default interval, configurable via `POLL_INTERVAL`)
- Trigger pattern matching
- Container spawning decisions
- Conversation catch-up (fetching messages since last agent interaction)
- Bot mode state (normal / silenced / degraded)
- Startup sequence (credential proxy → channels → scheduler → IPC → extraction → rota reminders → message loop)
- Graceful shutdown

**Coupling:** `index.ts` imports nearly everything. It's the integration point, not a library. The rest of the system is loosely coupled — `extraction.ts` doesn't know about `rota-commands.ts`, `subscriptions.ts` doesn't know about `digest.ts`.

### Layer 3: Container Execution

Isolated agent environments — one Docker container per conversation turn.

| File | Lines | Role |
|------|-------|------|
| `src/container-runner.ts` | 773 | Builds `docker run` commands: mounts, env vars, resource limits, settings.json, skills |
| `src/container-runtime.ts` | 158 | Detects Docker, finds docker0 bridge IP for credential proxy |
| `src/credential-proxy.ts` | 146 | HTTP proxy that injects real API keys into container requests |
| `src/mount-security.ts` | 419 | Validates host paths against allowlist, blocks sensitive patterns |
| `src/ipc.ts` | 490 | File-based IPC: watches for container output (messages, tasks) |
| `container/agent-runner/src/index.ts` | 631 | Runs inside Docker: Claude Agent SDK loop, tool filtering, session management |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 338 | MCP server inside container: `send_message`, `schedule_task`, `register_group` tools write IPC files |

**How a container spawns:**

```
index.ts → group-queue.ts → container-runner.ts
                                    │
                                    ├── mount-security.ts (validate paths)
                                    ├── credential-proxy.ts (start if needed)
                                    ├── Build docker run args:
                                    │   - Mount group folder → /workspace/group
                                    │   - Mount global folder → /workspace/global
                                    │   - Mount sessions → /home/node/.claude/
                                    │   - Mount per-group IPC dir → /workspace/ipc
                                    │   - Set ANTHROPIC_BASE_URL to proxy
                                    │   - Set resource limits (--memory, --pids-limit)
                                    │   - Write settings.json (allowedTools, model)
                                    │   - Copy agent-runner source into group folder
                                    │   └── Pipe conversation prompt to stdin
                                    │
                                    └── docker run --rm -i nanoclaw-agent:latest
                                            │
                                            └── agent-runner/index.ts
                                                ├── Parse config from stdin
                                                ├── Load CLAUDE.md (project settings)
                                                ├── Create Claude Agent SDK client
                                                ├── Filter tools via allowedTools
                                                ├── Start nanoclaw MCP server (ipc-mcp-stdio.ts)
                                                ├── Run agent loop
                                                └── Write response to stdout (via markers)

                                            ipc-mcp-stdio.ts (MCP server, runs in container)
                                                ├── send_message → writes to /workspace/ipc/messages/*.json
                                                ├── schedule_task → writes to /workspace/ipc/tasks/*.json
                                                └── register_group → writes to /workspace/ipc/tasks/*.json
```

**Security boundary:** Containers are the primary trust boundary. Real credentials never enter containers — the credential proxy intercepts API calls and injects auth headers. Containers run as unprivileged `node` user with `--cap-drop=ALL`, `--memory=2g` (configurable via `CONTAINER_MEMORY_LIMIT`), `--pids-limit=256`.

**IPC mechanism:** File-based, per-group namespaced. Each group gets its own IPC directory at `data/ipc/{groupFolder}/`, mounted into the container at `/workspace/ipc`. The container's MCP server writes JSON files to `messages/` and `tasks/` subdirectories. The host-side IPC watcher (`src/ipc.ts`) polls all group IPC directories at 1s intervals, processes the files, and deletes them. No sockets, no pubsub — just filesystem.

### Layer 4: Data

Persistent state — messages, groups, sessions, rota, purchases.

| File | Lines | Role |
|------|-------|------|
| `src/db.ts` | 1009 | SQLite schema, migrations, queries for messages, groups, topics, purchases |
| `src/rota-db.ts` | 880 | Rota-specific SQLite: shift assignments, identity binding, cover state |
| `src/attendee-db.ts` | 359 | Attendee import, identity resolution, display names |

**SQLite tables (db.ts):**
- `chats` — chat metadata (JID, name, last message time, channel)
- `messages` — all channel messages with timestamps, sender, thread_id
- `registered_groups` — which groups the bot serves (JID, folder, trigger, container config)
- `sessions` — conversation session IDs per group
- `topics` — forum topic discovery + extraction on/off flags
- `purchases` — tab tracking (user, item, price, timestamp)
- `scheduled_tasks` — task definitions, schedule, status, next run time
- `task_run_logs` — execution history (task ID, duration, result)
- `router_state` — message cursor positions

**SQLite tables (rota-db.ts):**
- `rota_meta` — import metadata (date range, source file hash)
- `rota_blocks` — shift block definitions (day, time range, station)
- `rota_assignments` — individual shift assignments, with identity binding columns (`original_telegram_id`) and cover state (`state`: assigned/open/covered, `current_person`/`current_name`/`current_telegram` for reassignment)
- `rota_log` — mutation audit trail (covers, releases, claims)
- `rota_no_shifts` — people explicitly marked as having no shifts
- `rota_notifications` — DM notification tracking (sent/pending)

**SQLite tables (attendee-db.ts):**
- `attendees` — imported attendee data (name, handle, email, etc.)

**WAL mode** is enabled for concurrent read access during container runs.

### Layer 5: Community Intelligence

The layer that makes this a community bot, not just a personal assistant.

| File | Lines | Role |
|------|-------|------|
| `src/extraction.ts` | 397 | Background loop (every 5 min): Haiku reads group messages, extracts facts/events/patterns → Mem0 |
| `src/mem0-client.ts` | 173 | HTTP client for Mem0 REST API |
| `src/mem0-local.ts` | 148 | In-memory Mem0 stub for testing |
| `src/seed.ts` | 562 | CLI tool: loads markdown knowledge files into Mem0 |
| `src/subscriptions.ts` | 113 | Keyword matching: extraction results → DM notifications |
| `src/digest.ts` | 138 | Creates daily + crew digest scheduled tasks |
| `src/dm-registration.ts` | 154 | Auto-registers DM containers when group members message the bot |
| `src/crew.ts` | 35 | Loads crew.json, checks crew membership |

**Memory architecture:**
- **Mem0** (via OpenMemory + Qdrant): Vector database for community knowledge. Single namespace `community:{slug}`. Extraction writes, agents search. DM containers can search but never write (enforced by `allowedTools` in agent-runner).
- **CLAUDE.md files**: Static agent instructions per group. Built from `governance/templates/` via `scripts/generate-claude-md.ts` or `governance/sync/constitution-sync.ts`.
- **SQLite**: Operational state. Messages, assignments, purchases, sessions.
- **Filesystem**: Container conversations archived in `groups/{name}/conversations/`.

**Extraction pipeline:**
```
src/extraction.ts (runs every 5 min on host, uses setTimeout self-pacing)
    │
    ├── For each main group (never DMs):
    │   ├── Fetch messages since last extraction from SQLite
    │   ├── Filter out messages from topics with extraction disabled
    │   ├── Include MIN_CONTEXT_MESSAGES=20 for cross-batch context
    │   ├── Inject active subscription topics into prompt
    │   ├── Send to Haiku with extraction prompt
    │   ├── Parse structured output (type, content, source)
    │   ├── Store each item in Mem0 via mem0-client.ts
    │   └── Check against subscriptions → queue DM notifications
    │
    └── What it extracts:
        ├── fact — events, schedule changes, facility status
        ├── proposal — activity proposals from community members
        ├── pattern — recurring interests across multiple people
        └── (ignores: introductions, diet, pronouns, health, rota, purchases, banter)
```

### Layer 6: Domain Features

Standalone feature modules — rota, purchases, admin.

| File | Lines | Role |
|------|-------|------|
| `src/rota-commands.ts` | 640 | Slash commands: /cover, /myrota, /shifts, /openshifts, /hands, /leaveearly |
| `src/rota-reminders.ts` | 266 | Morning announcements, pre-shift DM pings, uncovered shift warnings |
| `src/rota-print.ts` | 197 | PDF generation for printable daily shift sheets |
| `src/admin-commands.ts` | 541 | Admin slash commands, bot mode state, status reporting |
| `src/admin-http.ts` | 85 | HTTP admin endpoint (localhost-only, bearer token auth) |
| `src/admin-notify.ts` | 59 | DM notifications to admin (errors, summaries) |
| `src/sheet-adapter.ts` | 159 | Imports data from external sheet formats |

**Purchase system** lives entirely in `telegram.ts` (inline keyboards, SQLite reads/writes) — no separate module. Zero API cost.

**Rota system** is the most complex domain feature. Identity resolution is lazy: on first `/myrota` or `/cover`, the bot matches the Telegram user against imported assignment data (by Telegram ID, @handle, or display name) and binds permanently via the `original_telegram_id` column in `rota_assignments`. The cover flow is a state machine tracked by the `state` column (assigned → open → covered) plus `rota_log` for audit: release → post with [Claim] button → claim → DM notifications.

### Layer 7: Configuration & Templates

How agents get their instructions.

| File | Lines | Role |
|------|-------|------|
| `src/feature-config.ts` | 72 | Loads `groups/{name}/features.json`, merges with defaults |
| `src/sender-allowlist.ts` | 128 | Per-group sender filtering |
| `governance/sync/constitution-sync.ts` | 157 | API-based CLAUDE.md generation (requires GROUPS_CONFIG env) |
| `governance/sync/config.ts` | 33 | GroupConfig interface and loader |
| `scripts/generate-claude-md.ts` | 104 | Local CLAUDE.md generation from templates (no API dependency) |

**Template layering:**
```
governance/templates/base-template.md     ← Personality, behavior rules, MVG
governance/templates/group-template.md    ← Tools, Mem0 protocol, formatting
governance/templates/dm-overlay-template.md  ← DM-specific privacy wall, welcome
governance/templates/digest-prompt.md     ← Daily digest instructions
governance/templates/crew-digest-prompt.md ← Crew digest instructions
                    │
                    ▼
        generate-claude-md.ts (or constitution-sync.ts)
        Replaces {{community_name}}, {{crew_list}}, {{slug}}, etc.
        Strips disabled feature blocks (<!-- feature:X -->...<!-- /feature:X -->)
                    │
                    ▼
        groups/{name}/CLAUDE.md  ← What the agent actually sees
```

Two competing CLAUDE.md generation paths exist:
1. **Local** (`scripts/generate-claude-md.ts`): Reads templates + local config, writes CLAUDE.md. No network dependency. Used for Treeweek.
2. **API** (`governance/sync/constitution-sync.ts`): Fetches constitution from emergentvibe.com, builds CLAUDE.md. Requires `GROUPS_CONFIG` env var. Gated off when GROUPS_CONFIG is empty.

### Cross-Cutting Concerns

| File | Lines | Role |
|------|-------|------|
| `src/logger.ts` | 42 | Pino structured logging, optional Axiom transport |
| `src/rate-limit.ts` | 34 | Per-user message rate limiting |
| `src/timezone.ts` | 16 | Timezone helpers for date-aware features |
| `src/env.ts` | 42 | Environment variable loading |
| `src/types.ts` | 130 | Shared TypeScript interfaces |
| `src/group-folder.ts` | 44 | Group folder name validation + path resolution |

---

## Functional Flows

### Flow 1: User asks a question in group chat

```
1. User sends "@Andy what time is dinner?"
2. Telegram Bot API delivers message via polling
3. telegram.ts stores message in SQLite (db.ts)
4. Message loop (index.ts) polls SQLite (30s default), finds new message
5. Trigger pattern matches "^@Andy\b"
6. Conversation catch-up: fetch all messages since last agent interaction
7. group-queue.ts: check concurrency (< MAX_CONCURRENT_CONTAINERS?)
8. container-runner.ts: build Docker command
   - Mount groups/treeweek/ → /workspace/group
   - Mount groups/global/ → /workspace/global
   - Mount data/sessions/treeweek/.claude/ → /home/node/.claude/
   - Mount data/ipc/treeweek/ → /workspace/ipc
   - Set ANTHROPIC_BASE_URL to credential proxy
   - Pipe formatted conversation history to stdin
9. Docker container starts
   - agent-runner loads CLAUDE.md
   - Claude Agent SDK processes prompt
   - Agent calls search_memories("dinner schedule", user_id="community:treeweek")
   - Mem0 returns: "Dinner is at 6:30pm in the garden (announced by River)"
   - Agent responds: "Dinner's at 6:30 tonight in the garden — River announced the change earlier."
   - Response written to stdout via output markers
10. container-runner.ts reads stdout, sends via router.ts → telegram.ts
11. Message appears in Telegram group in the same topic
```

### Flow 2: Background extraction

```
1. extraction.ts timer fires (every 5 min, self-pacing setTimeout)
2. For each main group:
   a. Query SQLite for messages since last extraction timestamp
   b. Filter out messages from topics with extraction disabled
   c. Include 20 context messages from before the window
   d. Load active subscription topics
   e. Send to Haiku with extraction prompt
   f. Parse response: [{type: "fact", content: "...", source: "River"}]
   g. For each extracted item:
      - Store in Mem0 via mem0-client.ts
      - Check against subscriptions (subscriptions.ts)
      - If match: queue DM notification via IPC
   h. Update extraction timestamp in SQLite
```

### Flow 3: Purchase via NFC tap

```
1. User taps NFC sticker → opens t.me/BOT?start=bar
2. Telegram sends /start with payload "bar"
3. telegram.ts intercepts /start, maps payload to purchase category
4. If user not in a registered group → ignore
5. Send inline keyboard with drink buttons (prices from prices.json)
6. User taps "Beer (€3)"
7. Callback query arrives in telegram.ts
8. Write purchase to SQLite (db.ts): user_id, item, price, timestamp
9. Reply: "Beer — €3 ✓"
   (No container spawned. No API call. Pure SQLite.)
```

### Flow 4: Cover request flow

```
1. User sends /cover in group
2. telegram.ts → rota-commands.ts
3. rota-db.ts: resolve identity (Telegram ID → rota_assignments.original_telegram_id)
4. rota-db.ts: find user's upcoming shifts
5. Send inline keyboard with shift buttons
6. User taps a shift
7. rota-db.ts: set state='open', log mutation in rota_log
8. Post in Shifts topic: "Alex needs cover for Kitchen PM (Sep 24) — [Claim]"
9. Another user taps [Claim]
10. rota-db.ts: set state='covered', update current_person/current_name/current_telegram
11. DM both parties: "River claimed your Kitchen PM shift" / "You claimed Alex's shift"
    (No container. No API call.)
```

### Flow 5: DM registration

```
1. User sends /start or any message to bot DM
2. telegram.ts routes to dm-registration.ts
3. findCommunityForUser(): check if sender has messages in any registered main group
4. If found:
   a. Create DM folder: {mainGroupFolder}-dm-{sanitizedSenderId}
   b. Build DM-specific CLAUDE.md from base-template + dm-overlay-template
   c. Register DM group in SQLite with is_main=false
   d. DM container gets search-only Mem0 access (allowedTools restriction)
5. Welcome message sent from the container agent
```

---

## Coupling Map

```
                    ┌──────────────────┐
                    │    index.ts      │ ← orchestrates everything
                    │   (god object)   │
                    └──┬──┬──┬──┬──┬──┘
                       │  │  │  │  │
         ┌─────────────┘  │  │  │  └─────────────────┐
         │                │  │  │                     │
         ▼                │  │  │                     ▼
  ┌─────────────┐         │  │  │          ┌──────────────────┐
  │ telegram.ts │         │  │  │          │  extraction.ts   │
  │ (channel)   │         │  │  │          │  (background)    │
  └──────┬──────┘         │  │  │          └────────┬─────────┘
         │                │  │  │                   │
         ├── rota-commands│  │  │                   ├── mem0-client
         ├── rota-db      │  │  │                   ├── subscriptions
         ├── admin-commands│ │  │                   └── db (messages)
         ├── purchases (inline)│ │
         └── dm-registration  │  │
                              │  │
                              ▼  ▼
                    ┌──────────┐ ┌──────────────┐
                    │   db.ts  │ │container-runner│
                    │ (SQLite) │ │  (Docker)     │
                    └──────────┘ └──────┬───────┘
                                       │
                                       ├── credential-proxy
                                       ├── mount-security
                                       ├── ipc (file watcher)
                                       └── agent-runner (in container)
                                            │
                                            ├── Claude Agent SDK
                                            │   └── Mem0 MCP (search/add)
                                            └── ipc-mcp-stdio.ts
                                                └── nanoclaw MCP (send_message, schedule_task)
```

**Tight coupling:**
- `index.ts` ↔ everything (it's the integration point)
- `telegram.ts` ↔ `rota-commands.ts` ↔ `rota-db.ts` (rota flow)
- `telegram.ts` ↔ `admin-commands.ts` (admin flow)
- `container-runner.ts` ↔ `credential-proxy.ts` ↔ `mount-security.ts` (container setup)

**Loose coupling:**
- `extraction.ts` ↔ `subscriptions.ts` (extraction calls subscriptions, but subscriptions doesn't know about extraction)
- `digest.ts` ↔ `task-scheduler.ts` (digests register as tasks, scheduler runs them)
- `dm-registration.ts` ↔ `db.ts` (reads registered groups to find community)
- All feature modules ↔ `feature-config.ts` (check if they're enabled)

**No coupling:**
- Rota system ↔ extraction system (completely independent)
- Purchase system ↔ memory system (purchases never enter Mem0)
- Admin HTTP ↔ admin commands (separate entry points, share status logic)

---

## Data Flow Boundaries

### What enters Mem0 (vector DB)
- Extracted facts: events, schedules, facility status
- Activity proposals
- Patterns across multiple people
- Seeded knowledge files (via `src/seed.ts`)
- `/hello` introductions (via agent `add_memory` tool, group containers only)

### What stays in SQLite
- All raw messages (never deleted, used for catch-up and extraction)
- Rota assignments, identity bindings (in `rota_assignments`), mutation log (in `rota_log`)
- Purchases and tabs
- Forum topic metadata and extraction flags
- Scheduled tasks and run history
- Session IDs and router state

### What stays on filesystem
- `groups/{name}/CLAUDE.md` — agent instructions
- `groups/{name}/features.json` — feature toggles
- `groups/{name}/prices.json` — purchase prices
- `groups/{name}/crew.json` — crew member list
- `groups/{name}/subscriptions.json` — topic subscriptions
- `groups/{name}/conversations/` — archived container transcripts
- `data/ipc/{groupFolder}/` — transient per-group container ↔ host IPC files

### What never persists
- Bot mode (silenced/degraded) — in-memory only, resets on restart
- Rate limit counters — in-memory Map
- Container state — Docker manages lifecycle, orphans cleaned on boot

---

## Runtime Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                         HOST (Node.js)                               │
│                                                                       │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │Telegram │  │ Message  │  │  Task    │  │  Extraction Loop    │  │
│  │ Polling │  │  Loop    │  │ Scheduler│  │  (every 5 min)      │  │
│  │(channel)│  │(30s poll)│  │ (60s)    │  │                     │  │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └──────────┬──────────┘  │
│       │             │             │                    │              │
│       ▼             ▼             ▼                    ▼              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    SQLite (messages.db)                       │    │
│  │  chats │ messages │ registered_groups │ sessions │ topics     │    │
│  │  purchases │ scheduled_tasks │ task_run_logs │ router_state   │    │
│  │  rota_assignments │ rota_blocks │ rota_log │ attendees        │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌───────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Credential│  │   IPC    │  │  Admin   │  │ Rota Reminders  │   │
│  │  Proxy    │  │ Watcher  │  │  HTTP    │  │ (morning + DM)  │   │
│  │ (:3001)   │  │ (1s poll)│  │ (:3002)  │  │                 │   │
│  └─────┬─────┘  └──────────┘  └──────────┘  └─────────────────┘   │
│        │                                                              │
└────────┼──────────────────────────────────────────────────────────────┘
         │
         │  HTTP (API key injection)
         ▼
┌────────────────────┐  ┌────────────────────┐  ┌──────────────────┐
│  Docker Container  │  │  Docker Container  │  │  OpenMemory      │
│  (conversation 1)  │  │  (conversation 2)  │  │  + Qdrant        │
│                    │  │                    │  │  (:8765 / :6333) │
│  agent-runner      │  │  agent-runner      │  │                  │
│  Claude Agent SDK  │  │  Claude Agent SDK  │  │  Vector DB for   │
│  Mem0 MCP search   │  │  Mem0 MCP search   │  │  community memory│
│  nanoclaw MCP      │  │  nanoclaw MCP      │  │                  │
└────────────────────┘  └────────────────────┘  └──────────────────┘
```

**Concurrency:** Up to `MAX_CONCURRENT_CONTAINERS` (default 5) Docker containers run simultaneously. The `group-queue.ts` ensures one container per group at a time (serial within a group, parallel across groups). Additional messages for a group with an active container are queued.

**Startup order:**
1. SQLite initialization + migrations
2. Load registered groups, validate CLAUDE.md exists for each
3. Constitution sync (only when `GROUPS_CONFIG` env is set)
4. Ensure digest scheduled tasks for main groups
5. Start credential proxy (:3001)
6. Start admin HTTP (:3002, if `ADMIN_HTTP_TOKEN` set)
7. Connect channels (Telegram polling begins)
8. Init admin notifications
9. Start task scheduler (60s poll)
10. Start IPC watcher (1s poll)
11. Start extraction loop (5 min, self-pacing)
12. Start rota reminders (morning announcements, pre-shift DM pings)
13. Recover unprocessed messages from before shutdown
14. Start message loop

**Shutdown:** SIGINT/SIGTERM → stop rota reminders → close credential proxy → close admin HTTP → wait for active containers (10s timeout) → disconnect channels → exit.

---

## Test Architecture

| Layer | Framework | Count | What it tests |
|-------|-----------|-------|---------------|
| Unit tests | Vitest | ~791 | SQLite operations, feature config, rota logic, extraction parsing, routing, mounts |
| Behavioral tests | Vitest + real Anthropic API | 27 | Agent follows template rules (silence, extraction scope, DM privacy) |
| Integration sims | Custom runner (`tests/integration/sim-runner.ts`) | 27 | Full stack with Docker containers, Mem0, SimChannel replacing Telegram |

Behavioral tests are LLM-dependent — they send real prompts to Claude and assert on tool calls and responses. ~29 are skipped as known-flaky due to model non-determinism or Mem0 vector search latency.

**Integration sims** replace only the Telegram channel with a `SimChannel` that feeds scripted messages. Everything else runs as production: Docker containers, credential proxy, Mem0, extraction, IPC. Each sim has a scenario file defining messages, expected behaviors, and assertions.

---

## What's Not Here

- **No HTTP API for external clients.** Admin HTTP is localhost-only for kill switch / status. Everything else goes through Telegram.
- **No user accounts or auth.** Identity is Telegram ID. Admin is `ADMIN_TELEGRAM_ID` env var. Crew is `crew.json`.
- **No queuing system.** File-based IPC, polling loops, and `group-queue.ts` handle all coordination.
- **No caching layer.** Feature config and sender allowlist read from disk on every call. Fine at this scale.
- **No metrics or observability.** Structured pino logs, optional Axiom transport. No Prometheus, no dashboards.
