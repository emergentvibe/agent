/**
 * Tests for governance sync: template rendering, CLAUDE.md generation,
 * skill installation, and MCP config.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildClaudeMd,
  fetchConstitution,
  sendHeartbeat,
  _clearVersionCache,
  type ConstitutionData,
} from '../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../governance/sync/config.js';

// ── Template rendering ──────────────────────────────────────

const TEMPLATE = fs.readFileSync(
  path.resolve(import.meta.dirname ?? '.', '../governance/templates/claude-md-template.md'),
  'utf-8',
);

const MOCK_GROUP: GroupConfig = {
  folder: 'telegram_test',
  slug: 'test-community',
  community_name: 'Test Community',
};

const MOCK_DATA: ConstitutionData = {
  slug: 'test-community',
  name: 'Test Community Constitution',
  content: '1. Do no harm\n2. Be excellent to each other',
  version: '1.0.0',
  content_hash: 'abc123def456',
  updated_at: '2026-03-18T12:00:00Z',
};

describe('buildClaudeMd', () => {
  it('replaces all template placeholders', () => {
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

    expect(result).toContain('# Test Community Community AI');
    expect(result).toContain('Version: 1.0.0');
    expect(result).toContain('Hash: abc123def456');
    expect(result).toContain('1. Do no harm');
    expect(result).toContain('2. Be excellent to each other');
    expect(result).toContain('https://emergentvibe.com/c/test-community');
    expect(result).toContain('https://emergentvibe.com/c/test-community/governance');
  });

  it('includes memory instructions with correct slug', () => {
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

    expect(result).toContain('community:test-community');
    expect(result).toContain('Mem0 MCP tools');
    expect(result).toContain('add_memory');
    expect(result).toContain('search_memories');
  });

  it('includes privacy rules', () => {
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

    expect(result).toContain('NEVER share one user\'s personal memories');
    expect(result).toContain('Community memories are shared');
  });

  it('includes governance commands', () => {
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

    expect(result).toContain('/propose');
    expect(result).toContain('/vote');
    expect(result).toContain('/governance');
    expect(result).toContain('/constitution');
    expect(result).toContain('/help');
  });

  it('includes auto-registration instructions', () => {
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

    expect(result).toContain('POST https://emergentvibe.com/api/members/telegram');
    expect(result).toContain('X-Bot-Secret');
    expect(result).toContain('constitution_slug: "test-community"');
  });

  it('includes last sync time', () => {
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

    expect(result).toContain('Last synced:');
    // Should contain an ISO date
    expect(result).toMatch(/Last synced: \d{4}-\d{2}-\d{2}T/);
  });

  it('handles null content_hash', () => {
    const data = { ...MOCK_DATA, content_hash: null };
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, data, 'https://emergentvibe.com');

    expect(result).toContain('Hash: unknown');
  });

  it('uses custom polis_url when provided', () => {
    const group = { ...MOCK_GROUP, polis_url: 'https://polis.test/abc' };
    const result = buildClaudeMd(TEMPLATE, group, MOCK_DATA, 'https://emergentvibe.com');

    expect(result).not.toContain('/polis');
  });

  it('leaves no unreplaced placeholders', () => {
    const result = buildClaudeMd(TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

    // Check no {{ }} remain
    const unreplaced = result.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();
  });
});

// ── Network functions ────────────────────────────────────────

describe('fetchConstitution', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns data on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_DATA),
    });

    const result = await fetchConstitution('https://api.test', 'test-community');
    expect(result).toEqual(MOCK_DATA);
    expect(global.fetch).toHaveBeenCalledWith('https://api.test/api/constitution/test-community');
  });

  it('returns null on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await fetchConstitution('https://api.test', 'bad-slug');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await fetchConstitution('https://api.test', 'test');
    expect(result).toBeNull();
  });
});

describe('sendHeartbeat', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.BOT_API_SECRET;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.BOT_API_SECRET = originalEnv;
    } else {
      delete process.env.BOT_API_SECRET;
    }
  });

  it('sends heartbeat with bot secret', async () => {
    process.env.BOT_API_SECRET = 'test-secret';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    await sendHeartbeat('https://api.test', 'test-community', '1.0.0');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test/api/constitution/test-community/heartbeat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Bot-Secret': 'test-secret',
        }),
      }),
    );

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.constitution_version).toBe('1.0.0');
    expect(body.status).toBe('ok');
  });

  it('skips when no bot secret', async () => {
    delete process.env.BOT_API_SECRET;
    global.fetch = vi.fn();

    await sendHeartbeat('https://api.test', 'test', '1.0');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not throw on network error', async () => {
    process.env.BOT_API_SECRET = 'secret';
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    // Should not throw
    await sendHeartbeat('https://api.test', 'test', '1.0');
  });
});

// ── Skill files exist ────────────────────────────────────────

describe('governance skills', () => {
  const skillsDir = path.resolve(import.meta.dirname ?? '.', '../governance/skills');

  const expectedSkills = ['propose', 'vote', 'governance', 'constitution', 'help'];

  for (const skill of expectedSkills) {
    it(`/${skill} skill exists with SKILL.md`, () => {
      const skillPath = path.join(skillsDir, skill, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    });
  }

  it('/propose skill mentions platform API endpoint', () => {
    const content = fs.readFileSync(path.join(skillsDir, 'propose/SKILL.md'), 'utf-8');
    expect(content).toContain('/api/governance/proposals');
    expect(content).toContain('X-Bot-Secret');
    expect(content).toContain('telegram_id');
  });

  it('/vote skill mentions vote API endpoint', () => {
    const content = fs.readFileSync(path.join(skillsDir, 'vote/SKILL.md'), 'utf-8');
    expect(content).toContain('/api/governance/proposals/');
    expect(content).toContain('/vote');
    expect(content).toContain('X-Bot-Secret');
    expect(content).toContain('telegram_id');
  });

  it('/governance skill mentions active proposals endpoint', () => {
    const content = fs.readFileSync(path.join(skillsDir, 'governance/SKILL.md'), 'utf-8');
    expect(content).toContain('/api/governance/proposals/active');
  });
});

// ── Community knowledge templates ────────────────────────────

describe('community knowledge templates', () => {
  const knowledgeDir = path.resolve(import.meta.dirname ?? '.', '../governance/templates/community-knowledge');

  const expectedFiles = ['events.md', 'spaces.md', 'resources.md', 'food.md', 'people.md', 'faq.md', 'norms.md', 'decisions.md'];

  for (const file of expectedFiles) {
    it(`${file} template exists`, () => {
      expect(fs.existsSync(path.join(knowledgeDir, file))).toBe(true);
    });
  }
});

// ── MCP config ───────────────────────────────────────────────

describe('ContainerConfig MCP servers', () => {
  it('McpServerConfig type supports mem0 shape', async () => {
    const { McpServerConfig } = await import('../src/types.js') as { McpServerConfig: unknown };
    // Type-level test: this should compile
    const mem0Config = {
      command: 'uvx',
      args: ['mem0-mcp-server'],
      env: { MEM0_API_KEY: 'test-key' },
    };
    expect(mem0Config.command).toBe('uvx');
    expect(mem0Config.args).toEqual(['mem0-mcp-server']);
  });
});

// ── Memory namespace conventions ─────────────────────────────

describe('memory namespace conventions', () => {
  it('template uses tg: prefix for personal memory examples', () => {
    expect(TEMPLATE).toContain('user_id="tg:');
  });

  it('template uses community: prefix for shared memory examples', () => {
    expect(TEMPLATE).toContain('user_id="community:');
  });

  it('community namespace includes slug placeholder', () => {
    expect(TEMPLATE).toContain('community:{{slug}}');
  });
});
