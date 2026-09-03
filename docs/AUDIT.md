# Product & Code Audit — NanoClaw Community Intelligence Bot

Conducted 2026-09-02. Target: Treeweek III (Sep 22-29, ~40 people, 7-day coliving).
~4,000 lines of host code + ~600 lines agent-runner. 33 source files.

---

## Part 1: Product Audit

### Does the product story hold?

Yes. The core loop is coherent:

1. Bot reads all messages, stays silent
2. Extraction (Haiku, every 5 min) pulls facts/intros/wishes/patterns into Mem0
3. User asks `@Andy what time is dinner?` → container spawns → agent searches Mem0 → responds
4. Slash commands (`/today`, `/hello`, `/connect`, `/forget`) give structured access
5. Crew gets an evening digest with escalations; group gets an optional morning digest

This is a genuine product for temporary communities. Nothing else does this — shared memory for a group of 40 people who are together for a week. The design principles (silence > noise, privacy > features, honest > helpful) are well-encoded in the agent template and enforced by architecture.

### First-contact experience

**How does person #1 know the bot exists?**

The bot never speaks first. In a group, there is zero onboarding. Someone has to:
1. Notice the bot in the Telegram member list
2. Type a slash command (Telegram autocomplete shows the menu)
3. Or see someone else use it

This is fine for Treeweek — crew can introduce the bot verbally on day 1 and pin a message. But there's no in-product onboarding path. The `welcome_dm` behavior only fires *after* someone DMs the bot.

**Recommendation:** Crew should post a brief intro message on day 1 and pin it. Consider a one-line `/ping` response that mentions the available commands instead of just "Andy is online."

### Feature coherence

| Feature | Coherence | Notes |
|---------|-----------|-------|
| Extraction loop | Strong | Novel and well-designed. The sliding window + MIN_CONTEXT_MESSAGES is clever. |
| `/today`, `/hello`, `/connect` | Strong | Core use cases, well-documented in agent template |
| `/forget` | Adequate | Intro-only deletion. Enough for v1. |
| Escalation pipeline | Strong | Anonymous DM → IPC → file → crew digest. Privacy-first. Sim-tested. |
| Daily digest | Adequate | Note: this *breaks the silence contract*. The bot speaks unprompted every morning. Be deliberate about enabling it. |
| Crew digest | Strong | Actionable, includes escalations, DM'd privately |
| Subscriptions | Over-built | Simple keyword matching, off by default. Fine because it costs nothing when off. |
| Admin monitoring | Strong | Kill switch + status + error alerts. Exactly what you need for a live event. |

### Commands registered in Telegram but not documented in agent template

`/where` and `/recall` are in the Telegram command menu (`telegram.ts:77-88`) but NOT in the agent's CLAUDE.md template or `FEATURES.md`. They get rewritten to `@Andy /where kitchen` and the agent will search memory (which works), but the agent has no specific instructions for these commands. It'll handle them generically.

**Recommendation:** Either add `/where` and `/recall` to the agent template with specific behavior, or remove them from the Telegram command list. Mismatch between what the menu offers and what the agent is trained for.

### The silence contract

Solid. Multiple layers enforce it:
- `TRIGGER_PATTERN` requires `^@BotName\b` at message start
- Agent template: "Your default state is silence"
- `silencePattern` + `bracketSilence` regex in index.ts catches the agent narrating silence
- `/admin-silence` kill switch as escape hatch

**One leak:** The typing indicator fires when the bot is triggered (`setTyping(chatJid, true)`) and stays visible for the full container run (could be 30+ seconds). If the agent decides to stay silent, people still see "typing..." then nothing. Minor, but noticeable.

### The privacy contract

Well-enforced at multiple levels:
- `allowedTools` in agent-runner restricts DM containers to `search_memories` + `delete_memory`
- Extraction loop skips non-main groups: `if (!group.isMain) continue;`
- DM template repeats the no-add_memory rule 4 times
- Escalation anonymization is prompt-enforced (strong template, sim-tested)

**Tension worth knowing about (danah boyd lens):** The extraction loop processes ALL group messages through Haiku. The extraction prompt says to ignore banter and social coordination, but Haiku makes that judgment call. "Hey Sam want to grab dinner at 7?" could be stored as "dinner at 7." And the `source` metadata field catalogs who said what. People in temporary communities share a lot in group chats they consider semi-private. The extraction is doing what it should, but extraction of casual conversation into a persistent searchable database is inherently a surveillance-adjacent act. The design handles this well (epistemic markers, tentative language, no-inference rule), but be aware of the tension.

### What's missing for a 7-day gathering?

1. **No user-visible "what does the bot know?" command.** You can ask it, but there's no structured way to see what's been extracted. A `/memories` or `/what-do-you-know` could build trust.

2. **No queue feedback.** With MAX_CONCURRENT_CONTAINERS=10, if 15 people trigger the bot at once, 5 are queued. They just see "typing..." for a long time with no "hang on, I'm busy" message.

3. **No graceful degradation when Mem0 is down.** If Mem0 goes unreachable, the agent gets MCP errors and says "I don't have that info." No user-visible "memory is temporarily unavailable" message, no admin alert specifically for Mem0 health.

4. **No cost visibility.** No API cost tracking or estimation. 40 people over 7 days with Sonnet for DMs, Haiku for extraction, and group containers could get expensive. You'll want to watch the Anthropic dashboard manually.

### What's over-built for 7 days?

Nothing harmful. Subscriptions are off by default. The feature config system, while complex, is exactly the kind of insurance you want for a live event. Agent teams are enabled but harmless. The mount security system is thorough for what's essentially a single-operator deployment, but it's already built and doesn't add runtime cost.

---

## Part 2: Code Audit

### Dead code

| Location | Finding |
|----------|---------|
| `src/triage.ts` | 16 lines. `shouldRespond()` is never imported anywhere. The file comment says "extraction logic moved to extraction.ts." This entire file is dead. |
| `index.ts:80` | `export { escapeXml, formatMessages } from './router.js'` — "backwards compatibility during refactor." Nothing imports these re-exports. Dead. |
| `src/seed.ts` duplicates `src/mem0-client.ts` | Both have independent Mem0 API client implementations. seed.ts has `addMemory`, `listMemories`, `deleteMemory`, `searchMemories`. mem0-client.ts has `storeMemory`, `searchMemories`, `deleteMemoriesByUser`. Not dead, but redundant — seed.ts is a CLI tool so the duplication is tolerable. |

### Inconsistent patterns

1. **Two timer strategies.** Extraction uses `setInterval` (extraction.ts:321). IPC watcher and scheduler use `setTimeout` recursion (ipc.ts:159, task-scheduler.ts:275). The `setInterval` approach doesn't account for execution time — if extraction takes 4 minutes, the next cycle starts 1 minute later, not 5. Could cause overlapping cycles. The `setTimeout` pattern self-paces and is safer.

2. **Feature config reads from disk on every call.** `loadFeatureConfig()` (feature-config.ts:48) parses JSON from disk each time. Called in extraction loop, IPC watcher, digest task creation. No caching. Won't cause problems at this scale, but it's unnecessary I/O.

3. **Sender allowlist reads from disk on every message.** `loadSenderAllowlist()` (sender-allowlist.ts:33) does a full `fs.readFileSync` with no cache. Called 3 times per message in the hot path (index.ts:196, 466, 648). At 40 people sending a few messages per hour this is fine, but it's sloppy.

4. **mount-security.ts creates its own pino logger** (line 17-19) instead of using the shared `logger` from logger.ts. Log formatting won't be consistent.

### Fragile assumptions

1. **Extraction slug divergence.** `extraction.ts:219` uses `group.folder` as the Mem0 community slug. But `dm-registration.ts:119` extracts the slug from CLAUDE.md via regex `constitution_slug: "([^"]+)"`. If these ever diverge, extraction stores memories under one namespace and DM agents search a different one. Currently they're the same, but this is a latent bug — the slug should come from one canonical source.

2. **DM folder naming is load-bearing.** The pattern `{mainGroupFolder}-dm-{senderId}` is used for IPC routing, escalation storage, and community lookup via prefix matching (`sourceGroup.startsWith(g.folder + '-dm-')`). If a main group folder name happened to contain `-dm-`, prefix matching would false-positive. The group folder regex (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`) allows `-dm-` in names. Low probability, but structurally fragile.

3. **Container name timing collision.** `containerName = nanoclaw-${safeName}-${Date.now()}` (container-runner.ts:314). If two containers for the same group spawn in the same millisecond (burst of messages), Docker gets a name collision. Extremely unlikely, but not impossible under load.

### Things that could bite during a live event

1. **No container log rotation.** Each container run writes to `groups/{name}/logs/container-{timestamp}.log`. Over 7 days with active use, this could be hundreds of files. No cleanup mechanism. Won't crash anything, but disk usage grows.

2. **Agent-runner source copied on every container spawn.** `container-runner.ts:191-208` does `fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true })` every time. Same for skills sync (lines 153-168). Every single container launch copies these directories. At 40 people with DMs, that's a lot of redundant file copies.

3. **Extracted memories are fire-and-forget.** `extraction.ts:266` — `storeMemory(...).catch(err => logger.warn(...))`. If Mem0 rate-limits or has a transient error, that memory is gone. No retry, no queue, no dead-letter. Individual facts lost to a Mem0 blip aren't catastrophic, but a sustained outage means silent data loss.

4. **`setInterval` for extraction can overlap.** If `runExtractionCycle` takes longer than `EXTRACTION_INTERVAL` (5 min), the next cycle starts while the previous is still running. Both would process the same messages (since timestamps aren't updated until the end). Could produce duplicate Mem0 entries.

5. **No health check endpoint.** The credential proxy listens on port 3001 but has no `/health` route. External monitoring has nothing to ping. `/admin-status` requires a Telegram DM.

6. **`silenced` flag is in-memory only.** `admin-commands.ts:10` — `let silenced = false`. On process restart, the bot un-silences itself. Probably desired behavior, but if you silence the bot at 2am because it's misbehaving and the process restarts at 2:05am from a systemd watchdog, it comes back talking.

### Operational blindspots

1. **No metrics.** No message count, container duration, extraction success rate, Mem0 latency, or API cost tracking. Only visibility is structured pino logs.

2. **No way to inspect Mem0 at runtime.** The seed script has `--list` and `--search`, but there's no admin command to query Mem0 during the event without SSH.

3. **Admin status is sparse.** `/admin-status` shows uptime, group count, container count, silence state. Doesn't show: Mem0 health, last successful extraction, message volume, error rate, or API cost estimate.

4. **Container logs are per-group, on-disk.** No aggregation. To debug, you SSH in and grep files across directories.

### State management on restart

Well-handled:
- Message cursors, sessions, registered groups, extraction timestamps: all in SQLite
- `recoverPendingMessages()` on startup re-queues unprocessed messages
- `cleanupOrphans()` kills leftover containers
- Process crash between cursor advance and processing is handled by the two-cursor design (`lastTimestamp` vs `lastAgentTimestamp`)

---

## Summary

### Product verdict

The product is ready for Treeweek. The core loop (read → extract → answer) is sound. The privacy architecture is genuine, not cosmetic. The agent template is the best part — it encodes real wisdom about how a community memory tool should behave (epistemic markers, silence default, practiced-norm gap, pattern sensing awareness).

The main risk is human, not technical: the first few hours matter. If crew doesn't actively introduce the bot and demonstrate it, adoption may be slow. Consider having crew seed some knowledge and use `/today` and `/connect` publicly in the first hour.

### Code verdict

Clean and well-structured for a project of this scope. The architecture (file IPC, container isolation, extraction loop, feature config) is appropriate — not over-engineered, not under-built. The main issues are quality-of-life: disk reads in hot paths, a dead file, the extraction interval overlap risk.

### Priority fixes before deploy

**Should fix (prevents live-event pain):**
1. Add a health check route to the credential proxy (5 min)
2. Switch extraction from `setInterval` to self-pacing `setTimeout` (5 min)
3. Delete `src/triage.ts` and the dead re-exports in `index.ts:80` (2 min)
4. Add `/where` and `/recall` to the agent template, or remove from Telegram commands (10 min)

**Nice to fix (quality):**
5. Cache `loadFeatureConfig()` and `loadSenderAllowlist()` with a TTL or file-watcher
6. Add a simple admin command to check Mem0 health (`/admin-mem0`)
7. Persist `silenced` flag to SQLite so it survives restart

**Accept for v1:**
- No metrics (use Anthropic dashboard + Mem0 dashboard for cost/volume)
- No log rotation (7 days won't fill disk)
- Fire-and-forget Mem0 writes in extraction (extraction re-processes missed facts on next cycle... actually it doesn't, since timestamps advance. But individual lost facts aren't critical)
- Agent-runner copy on every spawn (wasteful but not harmful)
