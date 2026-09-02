# Community Intelligence Features

How the bot processes messages, extracts knowledge, and serves the community.

## How Messages Flow

```
User sends message in Telegram group
  → SQLite stores it
  → Polling loop checks trigger pattern (^@BotName)
  → If triggered: spawn Docker container with Claude Agent SDK
  → Agent responds via IPC → host routes to Telegram
  → If not triggered: message sits in DB, extraction picks it up later
```

The bot reads every message but only responds when directly addressed. This is by design — silence over noise.

## Trigger Pattern

Configured via `ASSISTANT_NAME` in `.env` (default: `Andy`). The pattern is `^@{name}\b` (case-insensitive, must be at start of message). Defined in `src/config.ts`.

## Slash Commands

Commands the agent recognizes when users message it. Each can be toggled per group via `features.json`.

| Command | What it does | Default |
|---------|-------------|---------|
| `/hello` | User introduces themselves. Stored in Mem0 under `community:{slug}`. | on |
| `/today` | Shows today's scheduled events and any recent operational changes. | on |
| `/connect` | Searches community introductions by interest/skill. "Who's into photography?" | on |
| `/forget` | Deletes the user's own introduction from community memory. Currently intro-only. | on |
| `/subscribe {topic}` | Get DM'd when extraction detects something matching that topic. | off |

## Behaviors

Background behaviors that don't require user interaction. Also toggled via `features.json`.

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
| `escalation` | Anonymous concern reporting via DM (see below). | off |

## Feature Config

Per-group file at `groups/{name}/features.json`. Merges with defaults — you only need to specify overrides.

```json
{
  "commands": {
    "subscribe": true
  },
  "behaviors": {
    "daily_digest": true,
    "crew_digest": true,
    "escalation": true
  }
}
```

If the file doesn't exist, all defaults apply. Loaded from `src/feature-config.ts`.

## Background Extraction

`src/extraction.ts` runs every 5 minutes (configurable via `EXTRACTION_INTERVAL`). Uses Haiku (`claude-haiku-4-5-20251001`) — not the main agent model.

**What it does:**
1. For each main group (never DMs), fetch messages since last extraction
2. Include a context window of already-extracted messages so cross-batch conversations aren't lost (`MIN_CONTEXT_MESSAGES=20`, `EXTRACTION_WINDOW=60min`)
3. Haiku classifies each message and extracts: operational facts, introductions, wishes, concerns, patterns
4. Stores results in Mem0 under `community:{slug}` with metadata (type, topic, tier, source)

**What it extracts:**
- `fact` — "The sauna is heated daily from 4pm to 10pm"
- `introduction` — "Sam introduced themselves as a photographer from Berlin"
- `wish` — "River expressed interest in morning swimming sessions"
- `concern` — "Multiple people mentioned noise levels after 10pm"
- `pattern` — "Several people (Alex, Priya, Sam) have asked about yoga"

**What it ignores:** Greetings, banter, jokes, questions without answers, social coordination.

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

## Escalation Pipeline

When `escalation` is enabled:

1. User DMs the bot with a concern
2. Agent offers anonymous escalation
3. User confirms
4. Agent writes IPC file: `{type: "escalation", text: "...", severity: "..."}`
5. Host IPC watcher (`src/ipc.ts`) reads it
6. `storeEscalation()` finds the parent group via DM folder prefix matching
7. Writes anonymized JSON to `data/escalations/{group}/{timestamp}.json`
8. Crew digest picks it up at 11pm

**Privacy:** The escalation text must not contain the person's name, message quotes, or identifying information. This is enforced by the DM agent template (`governance/templates/dm-template.md`).

## Subscriptions

When `subscribe` command is enabled:

1. User DMs bot: `/subscribe kitchen` or `/subscribe yoga`
2. Agent writes subscription to `groups/{name}/subscriptions.json`
3. When extraction runs and stores a memory containing "kitchen" or "yoga", `notifySubscribers()` in `src/extraction.ts` writes an IPC message
4. User gets a DM: "Heads up: [extracted fact]"

Matching is simple keyword inclusion (case-insensitive). Managed by `src/subscriptions.ts`.

## DM Registration

When someone DMs the bot for the first time (`src/dm-registration.ts`):

1. `findCommunityForUser()` checks if the sender has messages in any registered main group
2. If found, creates a DM folder: `{mainGroupFolder}-dm-{sanitizedSenderId}`
3. Writes a DM-specific `CLAUDE.md` from `governance/templates/dm-template.md`
4. DM container gets search-only Mem0 access (privacy wall)

The DM folder naming pattern `{mainGroup}-dm-{senderId}` is used by IPC routing, escalation storage, and community lookup. It's load-bearing.

## Privacy Boundaries

- **DM containers can search Mem0 but never write.** Enforced by `allowedTools` in `container/agent-runner/src/index.ts`: DMs get `search_memories` and `delete_memory` only.
- **Extraction only runs on main groups.** `src/extraction.ts`: `if (!group.isMain) continue;`
- **Escalations are anonymized.** No names, no quotes, no identifying info in stored escalation files.
- **Single Mem0 namespace.** All community knowledge under `community:{slug}`. No personal namespaces.
