# Phase 0: Community Intelligence Bot — Deployment

## Prerequisites

1. NanoClaw agent running with Telegram bot token
2. Constitution created on emergentvibe.com
3. Mem0 API key (free tier: https://app.mem0.ai)

## Environment Variables

Add to NanoClaw's environment (`.env` or deployment config):

```bash
# Memory (activates Mem0 MCP — code already exists in agent-runner)
MEM0_API_KEY=your_mem0_api_key

# Constitution sync
EMERGENTVIBE_API_URL=https://emergentvibe.com
GROUPS_CONFIG='[{"folder":"edge-esmeralda","slug":"emergentvibe","community_name":"Edge Esmeralda"}]'

# Bot auth
BOT_API_SECRET=your_bot_secret
```

## Community Knowledge Setup

Copy template files to the group's community-knowledge directory:

```bash
cp -r governance/templates/community-knowledge/ groups/edge-esmeralda/community-knowledge/
```

Then fill in the actual community information in each file:
- `spaces.md` — physical spaces, hours, access
- `events.md` — schedule, recurring events
- `food.md` — meals, kitchen, dietary info
- `people.md` — key contacts (opt-in only)
- `norms.md` — existing community agreements
- `faq.md` — common questions
- `welcome.md` — newcomer orientation

## Group Registration

Register the Telegram group via NanoClaw IPC:

```json
{
  "name": "Edge Esmeralda",
  "folder": "edge-esmeralda",
  "trigger": "bot",
  "requiresTrigger": false,
  "containerConfig": {
    "mcpServers": {},
    "timeout": 1800000
  }
}
```

Key: `requiresTrigger: false` — the bot processes every message for passive sensing.

## Daily Pulse (Scheduled Task)

After the bot is running, register the daily pulse via NanoClaw's `schedule_task`:

```json
{
  "type": "cron",
  "schedule": "0 18 * * *",
  "context_mode": "group",
  "prompt": "Review what you noticed in the community today. Search community memories from the last 24 hours. Write a brief pulse — max 5 bullet points — of what's happening. Include: any new wishes or concerns, any patterns you noticed, any connections you made. Keep it casual. If nothing notable happened, don't post anything."
}
```

## Verification Checklist

- [ ] Send a message in test group → bot stores relevant memories
- [ ] Send casual messages without @mention → bot stays silent but remembers
- [ ] Have 3 people mention same wish → bot surfaces the pattern
- [ ] Ask "where is the kitchen?" → bot answers from community-knowledge
- [ ] Wait for daily pulse → brief casual summary appears
- [ ] Store something in a DM → verify it doesn't leak to group
- [ ] Ask bot to forget something → verify deletion

## What's Next

Phase 0 → trust established → Phase 1:
- Add `/tension` and `/support` commands
- Lightweight "anyone object?" for wishes needing group buy-in
- Activity tracking for tier progression
