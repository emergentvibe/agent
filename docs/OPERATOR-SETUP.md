# Operator Setup Guide

How to deploy NanoClaw as a community intelligence bot for your community.

## Prerequisites

- A server (VPS, Railway, or local machine with Docker)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An Anthropic API key
- An OpenAI API key (for Mem0 embeddings)
- A constitution on [emergentvibe.com](https://emergentvibe.com) (or self-hosted)

## 1. Create Your Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token
4. Add the bot to your community group chat as an admin
5. Note the group chat ID (you can get this by adding [@userinfobot](https://t.me/userinfobot) to the group)

## 2. Create Your Constitution

1. Go to [emergentvibe.com](https://emergentvibe.com)
2. Create a constitution for your community
3. Write your principles — these will guide the AI's behavior
4. Note your constitution slug (the URL path, e.g., `edge-esmeralda`)

## 3. Set Up Memory (Mem0)

The bot uses Mem0 for shared community memory. Self-hosted is recommended for privacy.

```bash
# Clone the agent repo
git clone https://github.com/emergentvibe/agent.git
cd agent

# Start Mem0 (Qdrant + OpenMemory)
docker compose -f docker-compose.mem0.yml up -d
```

This starts:
- **Qdrant** on port 6333 (vector database)
- **OpenMemory** on port 8765 (Mem0 SSE server)

Verify it's running:
```bash
curl http://localhost:8765/health
```

## 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC...

# Memory (self-hosted)
MEM0_SSE_URL=http://localhost:8765/sse
OPENAI_API_KEY=sk-...

# Constitution sync
EMERGENTVIBE_API_URL=https://emergentvibe.com
BOT_API_SECRET=your-secret-here

# Groups config
GROUPS_CONFIG=[{"folder":"my-community","slug":"my-community","community_name":"My Community","admin_id":"123456789","admin_name":"Your Name","community_start_date":"2026-03-21"}]
```

### GROUPS_CONFIG format

JSON array of group objects:

| Field | Description |
|-------|-------------|
| `folder` | Local folder name for this group's data |
| `slug` | Constitution slug on emergentvibe.com |
| `community_name` | Display name |
| `admin_id` | Telegram user ID of the bootstrapper |
| `admin_name` | Display name of the bootstrapper |
| `community_start_date` | ISO date (YYYY-MM-DD) when community starts |

## 5. Run the Bot

### Option A: Docker (recommended for production)

```bash
docker compose up -d
```

### Option B: Local development

```bash
npm install
npm run build
npm start
```

## 6. Verify It's Working

1. Send a message in the Telegram group — the bot should respond to direct questions
2. DM the bot — it should initiate onboarding if you're the bootstrapper
3. Check logs: `docker compose logs -f`
4. Check heartbeat on emergentvibe.com — your community dashboard should show the bot as connected

## 7. Connect Claude Code Users

Community members using Claude Code can join the shared memory:

```bash
npx @emergentvibe/join my-community \
  --mem0-url http://your-server:8765/sse \
  --name "Their Name"
```

This configures their Claude Code to:
- Load your community's constitution as a CLAUDE.md
- Connect to the same Mem0 instance as the Telegram bot
- Share community memory under the `community:my-community` namespace

## Architecture

```
Your Server
├── NanoClaw (Telegram bot)
│   ├── Constitution sync (polls emergentvibe.com every 5 min)
│   ├── Container per conversation (Claude Code inside Docker)
│   └── Mem0 MCP connection
│
├── Mem0 (self-hosted)
│   ├── OpenMemory (:8765/sse)
│   └── Qdrant (:6333)
│
└── Shared Memory
    ├── community:{slug} — community knowledge
    ├── tg:{user_id} — Telegram user personal memory
    └── cc:{display_name} — Claude Code user personal memory
```

## Bootstrapper Phases

The bot's behavior changes automatically over time:

| Phase | Days | Bootstrapper Authority |
|-------|------|----------------------|
| Bootstrap | 1-3 | Seeds operational knowledge directly |
| Distribute | 4-14 | Operational updates only; social knowledge = peer |
| Release | 15+ | No special authority (system-enforced) |

## Troubleshooting

**Bot doesn't respond in group:**
- Check bot is admin in the group
- Check `GROUPS_CONFIG` has the correct group folder
- Check logs: `docker compose logs nanoclaw`

**Constitution sync fails:**
- Verify `EMERGENTVIBE_API_URL` is reachable
- Check your constitution slug matches `GROUPS_CONFIG`
- Check `BOT_API_SECRET` matches what's configured on emergentvibe.com

**Memory not working:**
- Verify Mem0 is running: `curl http://localhost:8765/health`
- Check `MEM0_SSE_URL` in `.env`
- Check OpenMemory logs: `docker compose -f docker-compose.mem0.yml logs`

**Claude Code user can't connect:**
- Ensure their machine can reach your Mem0 server (port 8765)
- For remote servers, set up a reverse proxy or SSH tunnel
