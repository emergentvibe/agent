# Deploy NanoClaw on a VPS

NanoClaw needs Docker-in-Docker (it spawns containers per conversation), so PaaS like Railway/Fly won't work. A cheap VPS with Docker is the simplest path.

## 1. Get a VPS

Any VPS with Docker support. Recommended: 2+ vCPU, 4GB RAM, 40GB+ disk.

- **DigitalOcean**: 4GB Droplet (~$24/mo). Pick region closest to venue.
- **Hetzner CX22**: (~€4/mo). Cheapest option.

Pick Ubuntu 24.04 LTS. Add your SSH key.

## 2. Install Docker + Node

```bash
ssh root@YOUR_IP

# Docker
curl -fsSL https://get.docker.com | sh

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Verify
docker --version
node --version
```

## 3. Clone and build

```bash
# Clone the repo
git clone https://github.com/emergentvibe/agent.git /opt/nanoclaw
cd /opt/nanoclaw

# Install deps
npm install

# Build the agent container image
docker build -t nanoclaw-agent:latest -f container/Dockerfile .

# Build NanoClaw
npm run build
```

## 4. Configure

```bash
cp .env.example .env
nano .env
```

Fill in (see `.env.example` for all options):
```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...          # from @BotFather
MEM0_API_KEY=m0-...             # from mem0.ai dashboard

# Bot identity
ASSISTANT_NAME=YourBot          # trigger word (@YourBot in chat)

# Cost optimization
GROUP_MODEL=claude-haiku-4-5-20251001  # cheaper for group chat
# DM_MODEL=claude-sonnet-5            # better quality for 1:1
MAX_CONCURRENT_CONTAINERS=5

# Admin
ADMIN_TELEGRAM_ID=...           # your Telegram user ID
ADMIN_HTTP_TOKEN=...            # openssl rand -hex 32

# Logging (optional)
# AXIOM_TOKEN=...
# AXIOM_DATASET=nanoclaw

# Group config
GROUPS_CONFIG='[{"folder":"my-community","slug":"my-community","community_name":"My Community","admin_id":"YOUR_TELEGRAM_ID","admin_name":"admin","community_start_date":"2026-09-22","governance_mode":"memory-only"}]'
```

## 5. Run

```bash
# Test run (foreground, see logs)
npm start

# Production (systemd)
cat > /etc/systemd/system/nanoclaw.service << 'EOF'
[Unit]
Description=NanoClaw Community Bot
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/nanoclaw
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/nanoclaw/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl enable nanoclaw
systemctl start nanoclaw
journalctl -u nanoclaw -f  # watch logs
```

## 6. Verify

1. Send a message in your Telegram group mentioning @BotName
2. Check logs: `journalctl -u nanoclaw -f`
3. You should see container spawn → Claude response → container cleanup

## 7. Monitoring

```bash
# Health check via admin HTTP endpoint
curl -s -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/status

# Kill switch
curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/pause
curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/resume
curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/degrade

# Credential proxy health
curl -s http://localhost:3001/health || echo "Proxy down"
```

If `AXIOM_TOKEN` is set, structured logs ship to Axiom automatically. Check the Axiom dashboard for errors, container events, and extraction results.

## 8. Update

```bash
cd /opt/nanoclaw
git pull
npm install
npm run build
docker build -t nanoclaw-agent:latest -f container/Dockerfile .
systemctl restart nanoclaw
```

## Costs

| Item | Cost |
|------|------|
| Hetzner CX22 | ~€4/mo |
| Anthropic API | ~$5-50/mo depending on usage |
| Mem0 cloud | Free tier or ~$10/mo |
| Domain (optional) | ~$10/yr |
| **Total** | **~$15-65/mo** |

## Troubleshooting

**Container won't start:** Check `docker info` — Docker daemon running?
**Bot doesn't respond:** Check `TELEGRAM_BOT_TOKEN` is correct. Check logs for errors.
**Memory not working:** Verify `MEM0_API_KEY` with: `curl -s -X POST "https://api.mem0.ai/v1/memories/search/" -H "Authorization: Token $MEM0_API_KEY" -H "Content-Type: application/json" -d '{"query":"test","user_id":"community:test"}'`
**High API costs:** Set `CLAUDE_MODEL=claude-haiku-4-5-20251001` in `.env`.
