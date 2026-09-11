# Deploy NanoClaw on a VPS

NanoClaw needs Docker-in-Docker (it spawns containers per conversation), so PaaS like Railway/Fly won't work. A VPS with Docker is the simplest path.

## 1. Get a VPS

Any VPS with Docker support. Recommended: 2+ vCPU, 4GB RAM, 40GB+ disk.

- **DigitalOcean**: 4GB Droplet (~$24/mo). Pick region closest to venue.
- **Hetzner CX22**: (~€4/mo). Cheapest but tight on RAM for Qdrant + Docker.

4GB minimum recommended — the stack runs Docker containers, Qdrant (vector DB), OpenMemory server, and Node.js concurrently.

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
# Clone the repo (treeweek branch)
git clone -b treeweek https://github.com/emergentvibe/agent.git /opt/nanoclaw
cd /opt/nanoclaw

# Install deps
npm install

# Build the agent container image
./container/build.sh

# Build NanoClaw
npm run build
```

## 4. Start OpenMemory (self-hosted Mem0)

Community memory uses self-hosted Mem0 via OpenMemory (Qdrant + MCP SSE server). No cloud API key needed.

```bash
cd /opt/nanoclaw
docker compose -f docker-compose.mem0.yml up -d

# Verify Qdrant is healthy
curl -s http://localhost:6333/healthz
```

Seed community knowledge after the bot is configured:

```bash
MEM0_SSE_URL=http://localhost:8765/sse npx tsx src/seed.ts community:treeweek knowledge/treeweek/
```

## 5. Configure

```bash
cp .env.example .env
nano .env
```

Fill in (see `.env.example` for all options):
```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...          # from @BotFather

# Self-hosted Mem0 (OpenMemory)
MEM0_SSE_URL=http://localhost:8765/sse

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
```

## 6. Run

```bash
# Test run (foreground, see logs)
node dist/src/index.js

# Production (systemd)
cat > /etc/systemd/system/nanoclaw.service << 'EOF'
[Unit]
Description=NanoClaw Community Bot
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/nanoclaw
ExecStart=/usr/bin/node dist/src/index.js
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

## 7. Verify

1. Send a message in your Telegram group mentioning @BotName
2. Check logs: `journalctl -u nanoclaw -f`
3. You should see container spawn → Claude response → container cleanup
4. Check extraction: wait 5 minutes, look for "Running memory extraction" in logs
5. Check Mem0: `curl -s http://localhost:6333/collections` should show data

## 8. Monitoring

```bash
# Health check via admin HTTP endpoint
curl -s -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/status

# Kill switch
curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/pause
curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/resume
curl -X POST -H "Authorization: Bearer $ADMIN_HTTP_TOKEN" http://localhost:3002/admin/degrade

# Credential proxy health
curl -s http://localhost:3001/health || echo "Proxy down"

# OpenMemory / Qdrant health
curl -s http://localhost:6333/healthz || echo "Qdrant down"
```

If `AXIOM_TOKEN` is set, structured logs ship to Axiom automatically.

## 9. Update

```bash
cd /opt/nanoclaw
git pull
npm install
npm run build
./container/build.sh
systemctl restart nanoclaw
```

## Costs

| Item | Cost |
|------|------|
| DigitalOcean 4GB | ~$24/mo |
| Anthropic API | ~$70-112/week (event week, 40 users) |
| Mem0 | $0 (self-hosted) |
| Domain (optional) | ~$10/yr |

## Troubleshooting

**Container won't start:** Check `docker info` — Docker daemon running?
**Bot doesn't respond:** Check `TELEGRAM_BOT_TOKEN` is correct. Check logs for errors.
**Memory not working:** Check OpenMemory: `docker compose -f docker-compose.mem0.yml logs`. Check Qdrant: `curl -s http://localhost:6333/healthz`.
**High API costs:** Set `GROUP_MODEL=claude-haiku-4-5-20251001` in `.env`.
**Entry point error:** Use `dist/src/index.js` (not `dist/index.js`). The tsconfig rootDir is `.` so src/ compiles to dist/src/.
