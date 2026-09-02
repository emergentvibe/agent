# Security Audit — Pre-Deployment

Audit date: 2026-09-02
Scope: All attack surfaces before deploying to ~40 people at Treeweek III (Sep 22-29)

## Fixed

### CRITICAL: Credential proxy bound to 0.0.0.0 on Linux fallback

**File:** `src/container-runtime.ts:41`
**Risk:** If `docker0` interface not found on the VPS, the credential proxy fell back to binding on `0.0.0.0` — exposing the Anthropic API key to anyone on the same network.
**Fix:** Changed fallback to `127.0.0.1` with a warning log. Operator must set `CREDENTIAL_PROXY_HOST` explicitly if containers can't reach localhost.

### HIGH: No Docker resource limits

**File:** `src/container-runner.ts:229`
**Risk:** A prompt-injected agent could fork-bomb or allocate unbounded memory, DoSing the host.
**Fix:** Added `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--memory=2g` (configurable via `CONTAINER_MEMORY_LIMIT`), `--pids-limit=256`.

### MEDIUM: No body size limit on credential proxy

**File:** `src/credential-proxy.ts:49`
**Risk:** A container sending a massive request body could OOM the proxy process.
**Fix:** Added 50MB body size limit with early request destruction on overflow.

## Accepted Risks

### Mem0 API key exposed to containers

**File:** `src/container-runner.ts:258-265`
**Risk:** `MEM0_API_KEY` is passed as an env var to containers. A prompt-injected agent could read it.
**Mitigation:** The `allowedTools` restriction limits what the SDK-level agent can do with Mem0. DM containers are restricted to `search_memories` and `delete_memory` only. A truly compromised agent could bypass SDK restrictions and call the Mem0 binary directly, but the Mem0 API key is scoped to a single project and can be rotated after the event.
**Future:** Consider routing Mem0 through a credential proxy similar to Anthropic, or using a per-container scoped token.

### Escalation anonymization is prompt-only

**Risk:** The DM agent template instructs the agent not to include identifying info in escalation text, but there's no code-level enforcement. A prompt-injected agent could write identifying info into escalation files.
**Mitigation:** The `escalation-anonymity` sim scenario tests this. The template is strong. Code-level stripping would require NLP-level name detection, which is fragile.

### Unrestricted container network access

**Risk:** Containers can reach the internet. Needed for Mem0 API and web search. A compromised agent could exfiltrate data.
**Mitigation:** Container sandbox limits what data is available. Project root is read-only. Secrets are proxied. The main risk is exfiltration of message content that the agent already has access to by design.

### No Mem0 cleanup/TTL

**Risk:** Community memories persist in Mem0 indefinitely after the event.
**Action needed:** After Treeweek, bulk-delete all memories under `community:treeweek` namespace. Mem0 cloud has a dashboard for this. Add a reminder to the post-event checklist.

## Positive Findings

| Surface | Status | Details |
|---------|--------|---------|
| SQL injection | **Safe** | Parameterized queries throughout `src/db.ts` |
| XML injection | **Safe** | `escapeXml()` in `src/router.ts` escapes all user content |
| IPC authorization | **Sound** | Directory-based identity, isMain checks, defense-in-depth |
| Group folder validation | **Solid** | Strict regex, path traversal checks, reserved names |
| Mount security | **Solid** | External allowlist, symlink resolution, blocked patterns |
| .env exposure | **Safe** | Shadowed with /dev/null in container mounts |
| Session isolation | **Safe** | Per-group `.claude/` directories |
| DM privacy wall | **Enforced** | `allowedTools` in agent-runner + extraction.ts skip |
| Container user | **Non-root** | Runs as `node` (uid 1000) |
| Credential proxy auth | **Sound** | Real keys injected server-side, never in containers |

## Recommendations for Production

1. Set `CREDENTIAL_PROXY_HOST` explicitly in `.env` on the VPS
2. Monitor `docker stats` for memory/CPU usage during the event
3. Set up log rotation for `logs/nanoclaw.log`
4. After the event, delete Mem0 memories and rotate the API key
5. Consider a cron job to clean up old container logs in `groups/*/logs/`
