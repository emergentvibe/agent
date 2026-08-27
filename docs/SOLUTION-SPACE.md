# Solution Space: Commands, Connection Engine, and Memory Architecture

*Input document for design panel. Maps all options before deciding direction.*

---

## 1. The Current System

### What Exists

| Component | State | How It Works |
|-----------|-------|-------------|
| **Memory store** | Mem0 Cloud API | `community:{slug}` namespace for shared knowledge, `tg:{id}` for personal. 45 memories seeded for demo. |
| **Seed script** | Working | `npm run seed -- --community <slug> --source ./knowledge/<slug>/`. Markdown → chunks → Mem0 with metadata. |
| **Bot** | Working | NanoClaw + grammY. Telegram messages → ephemeral Docker containers running Claude Code SDK. Mem0 MCP for memory. |
| **DMs** | Working | Auto-registered on first contact. Bot can reply. Bot can initiate DMs to registered users via IPC. |
| **Scheduling** | Working | Cron, interval, or one-shot tasks. Container spawns, runs prompt, sends output to group/DM. |
| **Silence** | Working | Bot reads every message, decides whether to respond. `<internal>` tags for reasoning. Silence pattern filter. |
| **Session persistence** | Working | Claude session ID stored in SQLite, resumed across container restarts. Full conversation history. |
| **File persistence** | Working | `/workspace/group/` bind-mounted. Files survive container restarts. |
| **IPC** | Working | Container can send messages, schedule tasks, register groups — all via filesystem IPC. |

### What Mem0 Can Do (Full API)

| Capability | Available | Notes |
|-----------|-----------|-------|
| Semantic search | Yes | Cosine similarity, configurable threshold and top_k |
| Metadata filtering | Yes (v2 API) | `AND`/`OR`/`NOT`, `eq`/`contains`/`gt`/`lt`/`in`. Filter by `metadata.type`, `metadata.topic`, etc. |
| Keyword search (BM25) | Yes | `keyword_search: true` parameter |
| Hybrid search | Yes | Semantic + metadata filter combined |
| Graph relations | Yes (read-only) | Extracted on add, returned on search. No direct graph query API. |
| Update in place | Yes | `PUT /v1/memories/{id}/` preserves ID |
| Batch update | Yes | Up to 1,000 per call |
| Memory history/audit | Yes | `GET /v1/memories/{id}/history/` |
| Cross-namespace search | No | One `user_id` per query. Must query separately and merge. |
| Webhooks | Yes | Real-time notifications on memory events |
| Export | Yes | Async export with schema |
| `infer: true` (LLM extraction) | Yes | Auto-deduplication, fact extraction from conversation |
| `infer: false` (verbatim) | Yes | Store exactly what you pass. Used by seed script. |

### Architecture Constraints

| Constraint | Implication |
|-----------|------------|
| Containers are ephemeral (`--rm`) | No long-running state inside containers. All persistence is external (Mem0, SQLite, files). |
| One Mem0 MCP connection per container | Agent can query any namespace, but it's the same API key/connection. |
| Bot can only DM users who've messaged first | Telegram limitation. Connection engine can't cold-DM people. |
| No cross-namespace search | Can't search "all users interested in music" across personal namespaces. Must use community namespace for matchable data. |
| Session resume works | Bot has full conversation history. Doesn't need Mem0 for short-term context. |
| Trigger required in groups | Bot only activates on @mention (or if `requiresTrigger: false`). Reads all messages for context though. |

---

## 2. Pre-Seeding (DONE — documenting for completeness)

### What We Built
- `npm run seed` script reads markdown, chunks by paragraph, stores with metadata
- Knowledge directory per community: `knowledge/<slug>/`
- Metadata: `type` (fact/norm), `topic` (spaces/meals/events/contacts/logistics/norms), `tier` (operational/social/constitutional), `source_context` (seed)

### Options Not Yet Explored

| Option | What | Effort | Value |
|--------|------|--------|-------|
| **A. Web form ingestion** | Organizer pastes text into web UI → API calls seed script | Medium (needs platform route + UI) | Better UX for non-technical organizers |
| **B. Document upload** | Organizer sends PDF/doc to bot in Telegram → bot extracts and seeds | Medium (needs file handling in container) | Chat-native, no web needed |
| **C. URL ingestion** | Organizer sends a Notion/Google Doc link → bot fetches and seeds | Medium (needs web fetch in container) | Lowest friction for organizers who already have docs |
| **D. Conversational seeding** | Bot asks questions, organizer answers, bot stores | Already exists (onboarding flow in CLAUDE.md) | Most natural but slow for large amounts of knowledge |
| **E. Structured event import** | Import from Luma/Google Calendar/iCal → structured event memories | Medium-high | Proper date/time handling for schedule queries |
| **F. `infer: true` mode** | Let Mem0's LLM extract facts from raw text dumps | Low (just change a flag) | Auto-deduplication, but less control over what gets stored |

---

## 3. Commands — Solution Space

### The Core Tension

The panels say "zero slash commands" (natural language only). The product plan has explicit commands (`/today`, `/where`, `/recall`, `/who`, `/hello`, `/connect`). The current system processes everything as natural language (commands are just behavioral instructions in CLAUDE.md).

### Option Matrix

#### Approach A: Pure Natural Language (Panel Recommendation)

No slash commands at all. Users just talk to the bot naturally.

**How it works:** User says "what's happening today?" or "where's the kitchen?" — bot searches Mem0, returns results.

| Pro | Con |
|-----|-----|
| Most natural interaction | Users don't know what the bot can do (discoverability) |
| No command parsing code needed | Inconsistent responses (model interpretation varies) |
| Matches panel research (R215, D57) | Harder to test — same question phrased differently may get different results |
| Low implementation effort | Can't provide structured output (e.g., a formatted schedule) |

#### Approach B: Slash Commands as CLAUDE.md Behavioral Instructions (Current)

Slash commands exist but are not parsed by code — they flow through as regular messages and the CLAUDE.md tells the model how to handle them.

**How it works:** User types `/recall wifi` → bot receives it as a text message → CLAUDE.md says "when you see /recall, search Mem0 for the topic" → bot searches and responds.

| Pro | Con |
|-----|-----|
| Easy to add new commands (just edit CLAUDE.md) | Model may misinterpret commands |
| Natural language also works alongside | No structured output guarantee |
| No code changes per command | Can't validate parameters |
| Users have a cheat sheet of what works | Feels like slash commands but doesn't have their reliability |

#### Approach C: Code-Level Command Handlers

Telegram bot registers command handlers in grammY. Parsed parameters are passed to the container as structured input.

**How it works:** User types `/today` → grammY handler catches it → extracts date → passes `{ command: 'today', date: '2026-03-29' }` to container → container runs Mem0 search with metadata filter `{ "metadata.topic": "events" }` → formats result.

| Pro | Con |
|-----|-----|
| Reliable, testable, consistent output | Every command needs code |
| Can use Mem0 metadata filters for precision | Loses flexibility — new commands need deployment |
| Can provide structured output (formatted schedule) | Two systems: commands + natural language |
| Users get Telegram command autocomplete | Feels more "app" and less "community member" |
| Can validate parameters | |

#### Approach D: Hybrid — Code Routing, AI Formatting

Commands are registered in Telegram (discoverability) but routing goes through the same AI pipeline with structured context injection.

**How it works:** User types `/today` → grammY catches it → injects structured context into the container prompt: `"The user asked for today's schedule. Today is Saturday, 2026-03-29. Search memories with metadata filter type=event. Format as a time-ordered list."` → AI searches and formats.

| Pro | Con |
|-----|-----|
| Discoverability (Telegram autocomplete) | More complex architecture |
| AI-quality formatting and reasoning | Still depends on model following instructions |
| Structured context improves retrieval accuracy | Command registration requires code changes |
| Natural language also works | |
| Can inject date/time context the model doesn't have | |

#### Approach E: Smart Defaults + Natural Language

No commands. Instead, the bot has "smart defaults" — certain question patterns trigger specific Mem0 search strategies. All handled in CLAUDE.md.

**How it works:** CLAUDE.md defines patterns: "When someone asks about time/schedule/today/tomorrow → search with metadata filter for events. When someone asks 'where is X' → search spaces + logistics. When someone asks 'who is/knows/does X' → search people." The model follows the pattern.

| Pro | Con |
|-----|-----|
| Feels completely natural | Model may not follow patterns reliably |
| No code, no command registration | Can't use Telegram autocomplete |
| Patterns are editable per community | Harder to test |
| Closest to "village elder" metaphor | Users discover capabilities by accident |

### Specific Command Analysis

| Command | What It Needs | Key Challenge |
|---------|--------------|---------------|
| `/today` or "what's on today?" | Current date + event memories with day-of-week matching | Bot doesn't know today's date unless injected. Seeded events are prose ("Monday, Wednesday, Friday") not structured dates. |
| `/where <place>` | Spaces + logistics memories | Works well with current semantic search. Low challenge. |
| `/recall <topic>` | Any memories matching topic | This is literally what Mem0 search does. Already works. |
| `/who <description>` | People memories | Works with current semantic search. Each person is a separate memory. |
| `/hello I'm [name]...` | Store introduction in community namespace | Needs to extract name + interests and store as searchable memory. Model can do this. |
| `/week` | All recurring events, formatted as schedule | Needs all event memories retrieved and formatted. Could use metadata filter `topic=events`. |

### The Date Problem

The bot runs in an ephemeral container. It doesn't inherently know what day it is. The CLAUDE.md template has a `{{current_date}}` placeholder but the container-runner doesn't inject it. Even if it did, the seeded events are prose-based ("Monday, Wednesday, Friday at 7pm") not structured.

**Options for date awareness:**
1. **Inject current date in container prompt** — low effort, bot can reason about day-of-week
2. **Structured event memories** — store events with `metadata.day: "monday"`, `metadata.time: "19:00"` — enables filtered retrieval
3. **Both** — inject date AND structure events. Most reliable.

---

## 4. Connection Engine — Solution Space

### The Core Problem

For connections to work, the bot needs to know people's interests. Where does that data live?

### Namespace Architecture Options

#### Option 1: Everything in Community Namespace

All introductions and interests go into `community:{slug}`. Anyone can search.

```
community:emergentvibe-demo contains:
  "Alice is a designer, into permaculture and community governance"
  "Marco is into music production and open source"
  "New member Zara introduced herself: into photography and cooking"
```

| Pro | Con |
|-----|-----|
| Simple — one namespace to search | No privacy for personal info |
| Connection matching works immediately | People may not want all interests public |
| Bot can answer "who's into X?" from one search | No distinction between "shared publicly" and "told the bot privately" |

#### Option 2: Personal Namespace + Community Index

Detailed personal info in `tg:{id}`. Summary/interests in `community:{slug}`.

```
tg:12345 contains:
  "I'm vegan, allergic to nuts"
  "I prefer DMs over group chat"
  "I'm interested in photography but don't want to be matched"

community:emergentvibe-demo contains:
  "Zara is interested in photography and cooking" (from /hello)
  "Zara joined on day 3"
```

| Pro | Con |
|-----|-----|
| Privacy by default | Two writes per interaction (or selective routing) |
| Personal preferences stay private | Bot needs to decide what's community-level vs personal |
| Community namespace only has "public" info | More complex CLAUDE.md instructions |
| `/who` searches community namespace (fast) | Personal namespace unsearchable by others (by design) |

#### Option 3: Consent-Based Routing

Bot asks before storing anything community-level. Personal by default.

```
User: "I'm into photography"
Bot: "Got it! Want me to share that with the group so people with similar interests can find you?"
User: "Sure"
Bot: → stores in community:{slug}
```

| Pro | Con |
|-----|-----|
| Maximum user control | Friction on every interaction |
| GDPR-friendly | People will say "just remember it" without understanding the distinction |
| Clear consent trail | Slows down onboarding |

#### Option 4: Public by Default in Group, Private by Default in DM

Messages in the group chat → community namespace. Messages in DMs → personal namespace. Simple rule the user can understand.

```
Group: "Hey I'm Zara, I'm into photography" → community:emergentvibe-demo
DM: "I have a nut allergy, please remember" → tg:12345
```

| Pro | Con |
|-----|-----|
| Simple, intuitive rule | Group messages may contain private info ("I have anxiety about...") |
| No consent friction | Bot needs to detect context (group vs DM) — already does this |
| Matches user mental model | Some interests only shared in DM won't be matchable |
| DMs are genuinely private | |

### Connection Matching Mechanics

#### How Does the Bot Find Matches?

| Approach | How | Reliability | Cost |
|----------|-----|------------|------|
| **Semantic search** | `search_memories(query="interested in photography", user_id="community:slug")` | Medium — depends on how interests are phrased | 1 API call |
| **Metadata filter** | Filter `metadata.type=introduction` then semantic match | Higher — narrows search space | 1 API call |
| **Graph relations** | Mem0 extracts `zara -- interested_in --> photography`, query graph | Medium — graph extraction is AI-derived, may miss things | Built into search |
| **Dedicated interest index** | Separate Mem0 namespace or file tracking `{person: interests[]}` | Highest reliability | More complexity |
| **Hybrid** | Semantic search + graph relations (already returned together) | Best of both | 1 API call (enable_graph: true) |

#### What Happens When a Match Is Found?

| Flow | Steps | UX |
|------|-------|-----|
| **A. Announce in group** | Bot says "Zara and Marco are both into photography — you should connect!" | Simple. No consent. May feel surveillant. |
| **B. DM consent** | Bot DMs each person: "Marco is also into photography, want an intro?" If both say yes → introduce. | Respectful. Requires both parties to have DMed the bot first. |
| **C. Passive discovery** | User asks "/who is into photography?" → bot returns list. User decides. | No proactive matching. User-initiated only. |
| **D. Opt-in matching** | User says "/connect me with someone into music" → bot searches → returns names. No unsolicited matching. | User controls when matching happens. |
| **E. Weekly digest** | Bot sends weekly DM: "Based on what you're into, you might want to meet: Marco (music), Priya (governance)" | Low frequency. Batch processing. Requires DM registration. |

### Connection Engine Architecture Options

#### Minimal (Recommended for v1)
- `/who is into X` → semantic search community namespace → return names
- `/connect me with someone into X` → same search → return names + brief context
- No proactive matching. No DMs. No consent flow.
- User decides whether to reach out.

#### Medium
- Everything in Minimal, plus:
- `/hello` stores structured introduction in community namespace
- Bot tracks connections made (to avoid re-suggesting)
- Bot can DM people for consent if asked: "introduce me to Marco"

#### Full (v2+)
- Everything in Medium, plus:
- Proactive weekly digest of potential connections
- Opt-in/opt-out matching preference per user
- Connection scoring (not just topic match but complementary skills)
- Cross-community connections (future: people at different emergentvibe communities)

---

## 5. Data Architecture — How Memories Should Be Structured

### Current Structure (Seeded)
```
text: "Kitchen: The kitchen is on the ground floor..."
metadata: { type: "fact", topic: "spaces", tier: "operational", source_context: "seed", source_file: "spaces.md" }
```

### Proposed Enhanced Structure

#### Events
```
text: "Community dinner on Monday, Wednesday, and Friday at 7pm"
metadata: {
  type: "event",
  topic: "meals",
  tier: "operational",
  recurrence: "mon,wed,fri",
  time: "19:00",
  source_context: "seed"
}
```

#### People/Introductions
```
text: "Marco is a developer from Lisbon, into music production and open source"
metadata: {
  type: "introduction",
  topic: "people",
  tier: "operational",
  person_name: "Marco",
  source_context: "seed"  // or "conversation" if from /hello
}
```

#### Norms
```
text: "Quiet hours are 10pm to 8am"
metadata: {
  type: "norm",
  topic: "noise",
  tier: "social",
  source_context: "seed"
}
```

### Why Structured Metadata Matters

With the v2 Mem0 API, we can do filtered searches:
- "What's happening today?" → filter `metadata.type=event` + semantic search → only event memories, not all 45
- "Who's here?" → filter `metadata.type=introduction` → only people
- "What are the rules about noise?" → filter `metadata.type=norm` + semantic "noise" → norms only

Without metadata filters, every search returns the top 10 most semantically similar memories regardless of type. The wifi password might show up when you ask about dinner.

---

## 6. Stretch Options (High Effort, High Potential)

| Option | What | Effort | Why It's Interesting |
|--------|------|--------|---------------------|
| **Self-hosted Qdrant + direct queries** | Run Qdrant locally, bypass Mem0 for operational queries | High | Sub-millisecond filtered retrieval. True structured queries. No API rate limits. |
| **Graph DB for connections** | Neo4j/Memgraph for person-interest-person graph | High | Direct graph traversal: "friends of friends who share interests" |
| **Webhook-driven updates** | Mem0 webhooks trigger bot actions when new memories are added | Medium | Real-time: someone adds event → bot updates schedule view |
| **Memory export → dashboard** | Async export of all memories → generate community dashboard | Medium | Visual overview of community knowledge |
| **Multi-community pattern sharing** | Search across community namespaces for common patterns | High | "Other communities solved noise complaints like this" |
| **Calendar integration** | Sync with Google Calendar/Luma → structured event memories | Medium | Proper schedule handling with real dates and times |
| **Voice notes → memory** | Telegram voice messages → transcription → Mem0 | Medium | People share more naturally by voice |
| **Mem0 `infer: true` for chat** | Let Mem0 auto-extract facts from group chat messages | Low | Automatic knowledge building from conversation. But less control. |

---

## 7. Decision Points for Panel

1. **Commands: which approach?** (A-E above) — affects implementation, UX, and bot personality
2. **Namespace routing: which option?** (1-4 above) — affects privacy, connection matching, and complexity
3. **Connection matching: which flow?** (A-E above) — affects trust, proactivity, and privacy
4. **Memory structure: flat text vs enriched metadata?** — affects retrieval precision
5. **Date awareness: how?** — affects schedule/event commands
6. **Scope for v1: minimal/medium/full?** — what ships now vs later
