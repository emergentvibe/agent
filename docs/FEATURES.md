# Community Intelligence Features

How the bot processes messages, extracts knowledge, and serves the community.

## How Messages Flow

```
User sends message in Telegram group
  → SQLite stores it (with thread_id if in a Forum topic)
  → Polling loop checks trigger pattern (^@BotName)
  → If triggered: spawn Docker container with Claude Agent SDK
  → Agent responds via IPC → host routes to correct Telegram topic
  → If not triggered: message sits in DB, extraction picks it up later
```

The bot reads every message but only responds when directly addressed. This is by design — silence over noise.

Users can also tag the bot and describe what they want in natural language — it doesn't require slash commands. "@Bot who's into photography?" works the same as `/connect photography`. Slash commands are signifiers for discoverability; the AI pipeline handles both.

## Trigger Pattern

Configured via `ASSISTANT_NAME` in `.env` (default: `Andy`). The pattern is `^@{name}\b` (case-insensitive, must be at start of message). Defined in `src/config.ts`.

## Bot Modes

Three operating modes, controlled via admin commands or HTTP endpoint:

| Mode | Behavior |
|------|----------|
| `normal` | Full operation — responds to triggers, runs extraction, processes all features |
| `silenced` | Complete stop — no responses, no extraction, no digests |
| `degraded` | Responds with "I'm taking a short break — back soon" to triggers. Extraction continues. Cursor advances (no message pile-up on resume). |

Set via `/admin-silence` (Telegram), or `POST /admin/pause`, `POST /admin/degrade`, `POST /admin/resume` (HTTP).

## Forum Topic Support

Telegram Forum mode (topics/threads within a single group) is fully supported:

- `thread_id` is stored with every message and flows through the entire pipeline
- Bot replies in the same topic where it was triggered
- General topic edge case handled (Telegram rejects `message_thread_id=1`)
- Per-topic extraction control: admins enable/disable which topics get memory extraction

Topic discovery is automatic — the bot registers topics from forum metadata on messages it receives.

## Slash Commands

Commands the agent recognizes. Each can be toggled per group via `features.json`. All of these also work via natural language when tagging the bot.

| Command | What it does | Default |
|---------|-------------|---------|
| `/today` | Shows today's scheduled events and recent operational changes. | on |
| `/intro` | User introduces themselves. Stored in Mem0 under `community:{slug}`. | on |
| `/connect [interest]` | Searches community introductions by interest/skill. | on |
| `/subscribe [topic]` | Get DM'd when extraction detects something matching that topic. Handled by host (no container). | on |
| `/unsubscribe [topic]` | Remove a topic subscription. Handled by host. | on |

### Purchase Commands (local, zero API cost)

These are handled entirely by the Telegram channel — no containers, no Claude API calls. Pure SQLite.

| Command | What it does |
|---------|-------------|
| `/bar` | Inline keyboard with drink buttons. Tap = instant purchase. |
| `/bbq` | Inline keyboard with food buttons. |
| `/purchase` | All items across categories. |
| `/show_total` | Your itemized tab with running total. |
| `/cancel_purchase` | Undo your last purchase. |

Prices are configured per group in `groups/{name}/prices.json`:
```json
{
  "bar": { "beer": 3, "wine": 5, "soft-drink": 2 },
  "bbq": { "burger": 5, "chicken": 4 }
}
```

### Deep Links (NFC stickers, DM entry)

The `/start` handler maps payloads to features:

| URL | Action |
|-----|--------|
| `t.me/BOT?start=bar` | Opens bar purchase keyboard |
| `t.me/BOT?start=bbq` | Opens BBQ purchase keyboard |
| `t.me/BOT?start=tab` | Shows user's purchase total |
| `t.me/BOT?start=wifi` | Quick answer (via container) |
| `t.me/BOT?start=today` | Today's schedule (via container) |
| `t.me/BOT?start=info` | Community info (via container) |
| `t.me/BOT?start=connect` | Connection matching (via container) |

These map to NFC sticker URLs for physical placement at venues.

## Admin Commands

Telegram commands, gated by `ADMIN_TELEGRAM_ID`. Work in both DMs and group chat (avoid running in group — they leak status info).

| Command | What it does |
|---------|-------------|
| `/admin-silence` | Full silence mode. `/admin-silence off` to resume. |
| `/admin-status` | Mode (normal/silenced/degraded), uptime, groups, active tasks, running containers. |
| `/admin-topics` | List all discovered Forum topics with extraction on/off status. |
| `/admin-extract-on [topic]` | Enable memory extraction for a topic (by name or thread ID). |
| `/admin-extract-off [topic]` | Disable memory extraction for a topic. |
| `/admin-tab` | All users with non-zero purchase totals. |
| `/admin-tab [userId]` | One user's itemized purchases. |
| `/admin-tab export` | CSV export of all purchases. |

## HTTP Admin Endpoint

Bearer-token-authenticated HTTP server. Binds to `127.0.0.1` only (localhost). Disabled when `ADMIN_HTTP_TOKEN` is not set.

| Endpoint | Method | Action |
|----------|--------|--------|
| `/admin/status` | GET | JSON: mode, uptime_ms, groups, active_tasks, running_containers |
| `/admin/pause` | POST | Full silence |
| `/admin/resume` | POST | Resume (clears both silenced and degraded) |
| `/admin/degrade` | POST | Degraded mode |

Auth: `Authorization: Bearer <ADMIN_HTTP_TOKEN>` header required.

Config: `ADMIN_HTTP_PORT` (default 3002), `ADMIN_HTTP_TOKEN` in `.env`.

## Behaviors

Background behaviors that don't require user interaction. Toggled via `features.json`.

| Behavior | What it does | Default |
|----------|-------------|---------|
| `memory_extraction` | Background loop extracts facts from group chat to Mem0 (see below). | on |
| `welcome_dm` | Auto-registers DM when a group member first messages the bot privately. | on |
| `pattern_sensing` | Agent notices emerging patterns ("several people have mentioned wanting..."). | on |
| `epistemic_markers` | Agent qualifies statements with source attribution ("Alex mentioned..."). | on |
| `operational_history` | Agent references how things have changed ("dinner was at 7, now 6:30"). | on |
| `first_person_authority` | "I'm vegan" from the person overrides "Sam eats anything" from others. | on |
| `daily_digest` | Morning summary posted to group at 8am. | off |
| `crew_digest` | Evening summary DM'd to crew members at 11pm. Includes escalations. | off |
| `escalation` | Anonymous concern reporting via DM. **Deprecated** — removed from templates, disabled by default. | off |

## Feature Config

Per-group file at `groups/{name}/features.json`. Merges with defaults — you only need to specify overrides.

```json
{
  "commands": {
    "subscribe": true,
    "purchase": true
  },
  "behaviors": {
    "daily_digest": true,
    "crew_digest": true,
    "escalation": false
  }
}
```

If the file doesn't exist, all defaults apply. Loaded from `src/feature-config.ts`.

## Background Extraction

`src/extraction.ts` runs every 5 minutes (configurable via `EXTRACTION_INTERVAL`). Uses Haiku (`claude-haiku-4-5-20251001`) — not the main agent model.

**What it does:**
1. For each main group (never DMs), fetch messages since last extraction
2. Filter out messages from topics with extraction disabled
3. Include a context window of already-extracted messages so cross-batch conversations aren't lost (`MIN_CONTEXT_MESSAGES=20`, `EXTRACTION_WINDOW=60min`)
4. Haiku classifies each message and extracts: operational facts, introductions, wishes, concerns, patterns
5. Stores results in Mem0 under `community:{slug}` with metadata (type, topic, tier, source)
6. Checks extracted memories against subscriptions and queues DM notifications for matches

**What it extracts:**
- `fact` — "The sauna is heated daily from 4pm to 10pm"
- `introduction` — "Sam introduced themselves as a photographer from Berlin"
- `wish` — "River expressed interest in morning swimming sessions"
- `concern` — "Multiple people mentioned noise levels after 10pm"
- `pattern` — "Several people (Alex, Priya, Sam) have asked about yoga"

**What it ignores:** Greetings, banter, jokes, questions without answers, social coordination.

**Per-topic control:** Topics default to extraction OFF. General (thread_id null or 1) is always on. Use `/admin-extract-on [topic]` to enable extraction for specific topics. Topic registry in SQLite (`topics` table).

## Crew System

`groups/{name}/crew.json` lists crew members:

```json
[
  {"id": "tg:123456", "name": "Jordan"},
  {"id": "tg:789012", "name": "Alex"}
]
```

Crew members get elevated trust on operational matters and receive the crew digest. Loaded by `src/crew.ts`.

## Digests

**Daily digest** (`daily_digest` behavior): Cron task at 8am. Posts to the group chat. Searches Mem0 for the last 24 hours of community activity — events, changes, patterns. Template at `governance/templates/digest-prompt.md`.

**Crew digest** (`crew_digest` behavior): Cron task at 11pm. DM'd to each crew member. Includes Mem0 activity plus reads `data/escalations/{group}/` for anonymous reports. Template at `governance/templates/crew-digest-prompt.md`.

Both are registered as scheduled tasks in SQLite by `src/digest.ts`. The task scheduler (`src/task-scheduler.ts`) runs them. Timezone follows `TZ` env var or system default.

## Escalation Pipeline (deprecated)

> Escalation was removed from agent templates in Phase A. The code still exists but is disabled by default. Do not re-enable without discussion.

When `escalation` is enabled:

1. User DMs the bot with a concern
2. Agent offers anonymous escalation
3. User confirms
4. Agent writes IPC file: `{type: "escalation", text: "...", severity: "..."}`
5. Host IPC watcher (`src/ipc.ts`) reads it
6. `storeEscalation()` finds the parent group via DM folder prefix matching
7. Writes anonymized JSON to `data/escalations/{group}/{timestamp}.json`
8. Admin gets a DM notification immediately (`src/admin-notify.ts`)
9. Crew digest picks it up at 11pm

**Privacy:** The escalation text must not contain the person's name, message quotes, or identifying information. Enforced by the DM agent template (`governance/templates/dm-overlay-template.md`).

## Subscriptions

When `subscribe` command is enabled:

1. User sends `/subscribe kitchen` or `/subscribe yoga` (group or DM)
2. Host writes subscription to `groups/{name}/subscriptions.json` (no container spawned)
3. When extraction runs and stores a memory containing "kitchen" or "yoga", `findMatchingSubscriptions()` in `src/subscriptions.ts` matches it
4. Notification queued via IPC → user gets a DM

`/unsubscribe [topic]` removes the subscription. Both commands are host-handled in `telegram.ts` — no containers, no API cost. Matching is simple keyword inclusion (case-insensitive). Managed by `src/subscriptions.ts`.

## DM Registration

When someone DMs the bot for the first time (`src/dm-registration.ts`):

1. `findCommunityForUser()` checks if the sender has messages in any registered main group
2. If found, creates a DM folder: `{mainGroupFolder}-dm-{sanitizedSenderId}`
3. Writes a DM-specific `CLAUDE.md` from `governance/templates/base-template.md` + `dm-overlay-template.md`
4. DM container gets search-only Mem0 access (privacy wall)

The DM folder naming pattern `{mainGroup}-dm-{senderId}` is used by IPC routing, escalation storage, and community lookup. It's load-bearing.

## Admin Notifications

`src/admin-notify.ts` sends DMs to the admin (`ADMIN_TELEGRAM_ID`) for:

- **Escalation alerts**: Immediately when someone escalates a concern
- **Error notifications**: Container crashes, extraction failures
- **Summary**: Optional daily summary

## Logging

Structured logging via pino (`src/logger.ts`). When `AXIOM_TOKEN` is set, logs ship to Axiom via `@axiomhq/pino` transport alongside local `pino-pretty` output. Container stderr lines are logged with `source: 'container'` and group context for Axiom filtering.

Config: `AXIOM_TOKEN`, `AXIOM_DATASET` (default: `nanoclaw`) in `.env`.

## Privacy Boundaries

- **DM containers can search Mem0 but never write.** Enforced by `allowedTools` in `container/agent-runner/src/index.ts`: DMs get `search_memories` and `delete_memory` only.
- **Extraction only runs on main groups.** `src/extraction.ts`: `if (!group.isMain) continue;`
- **Per-topic extraction control.** Only topics explicitly enabled have their messages extracted.
- **Escalations are anonymized.** No names, no quotes, no identifying info in stored escalation files.
- **Single Mem0 namespace.** All community knowledge under `community:{slug}`. No personal namespaces.
- **Credential proxy.** Anthropic API key never enters containers — proxied via `src/credential-proxy.ts`.

## MVG Rules

The Seven Minimum Viable Governance rules (from the memory-as-commons research) form the behavioral backbone. They override everything else when in conflict:

1. Anyone can contribute knowledge
2. Anyone can query knowledge
3. Anyone can see what changed
4. Conflicts surface both sides (never resolve silently)
5. Constitutional questions are flagged for humans (never decided by the bot)
6. Knowledge ages (mention when info is old)
7. No permissions hierarchy (tiers classify knowledge, not people)
