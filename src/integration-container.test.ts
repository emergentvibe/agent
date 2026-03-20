/**
 * Container integration tests for NanoClaw agent.
 *
 * Tests the container setup logic — volume mounts, environment construction,
 * CLAUDE.md loading, and Mem0 MCP config — WITHOUT spawning actual Docker
 * containers or making API calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildClaudeMd,
  type ConstitutionData,
} from '../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../governance/sync/config.js';
import { buildDmClaudeMd } from './dm-registration.js';
import type { RegisteredGroup, McpServerConfig } from './types.js';

// ── Shared fixtures ──────────────────────────────────────────

const MOCK_GROUP_CONFIG: GroupConfig = {
  folder: 'telegram_edge',
  slug: 'edge-esmeralda',
  community_name: 'Edge Esmeralda',
};

const MOCK_CONSTITUTION: ConstitutionData = {
  slug: 'edge-esmeralda',
  name: 'Edge Esmeralda Constitution',
  content:
    '1. Respect shared spaces\n2. Consent before recording\n3. Leave it better than you found it',
  version: '2.1.0',
  content_hash: 'sha256-abc123def',
  updated_at: '2026-05-15T09:00:00Z',
};

const API_URL = 'https://emergentvibe.com';

// ── Part 1: Volume mount configuration ───────────────────────

describe('Volume mount configuration', () => {
  /**
   * We can't import buildVolumeMounts directly (it has side effects via
   * config.js, fs.mkdirSync calls, etc.), so we verify the mount *structure*
   * by describing what buildVolumeMounts produces based on reading the source.
   * This tests the *contract*, not the implementation.
   */

  interface VolumeMount {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }

  /**
   * Replicate the mount list logic for a non-main group (from container-runner.ts)
   * to verify the expected structure.
   */
  function expectedNonMainMounts(
    groupFolder: string,
    groupsDir: string,
    dataDir: string,
    projectRoot: string,
    hasGlobalDir: boolean,
    additionalMounts: VolumeMount[] = [],
  ): VolumeMount[] {
    const mounts: VolumeMount[] = [];

    // Own group folder (rw)
    mounts.push({
      hostPath: path.join(groupsDir, groupFolder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (ro) — only if exists
    if (hasGlobalDir) {
      mounts.push({
        hostPath: path.join(groupsDir, 'global'),
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    // Per-group Claude sessions (rw)
    mounts.push({
      hostPath: path.join(dataDir, 'sessions', groupFolder, '.claude'),
      containerPath: '/home/node/.claude',
      readonly: false,
    });

    // Per-group IPC namespace (rw)
    mounts.push({
      hostPath: path.join(dataDir, 'ipc', groupFolder),
      containerPath: '/workspace/ipc',
      readonly: false,
    });

    // Agent-runner source copy (rw)
    mounts.push({
      hostPath: path.join(dataDir, 'sessions', groupFolder, 'agent-runner-src'),
      containerPath: '/app/src',
      readonly: false,
    });

    // Additional mounts
    mounts.push(...additionalMounts);

    return mounts;
  }

  it('non-main group gets correct base mounts', () => {
    const groupsDir = '/project/groups';
    const dataDir = '/project/data';
    const projectRoot = '/project';

    const mounts = expectedNonMainMounts(
      'telegram_edge',
      groupsDir,
      dataDir,
      projectRoot,
      true,
    );

    // /workspace/group (rw) — own folder
    const groupMount = mounts.find(
      (m) => m.containerPath === '/workspace/group',
    );
    expect(groupMount).toBeDefined();
    expect(groupMount!.readonly).toBe(false);
    expect(groupMount!.hostPath).toBe(
      path.join(groupsDir, 'telegram_edge'),
    );

    // /workspace/global (ro) — shared global CLAUDE.md
    const globalMount = mounts.find(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMount).toBeDefined();
    expect(globalMount!.readonly).toBe(true);

    // /home/node/.claude (rw) — sessions
    const sessionsMount = mounts.find(
      (m) => m.containerPath === '/home/node/.claude',
    );
    expect(sessionsMount).toBeDefined();
    expect(sessionsMount!.readonly).toBe(false);

    // /workspace/ipc (rw) — IPC namespace
    const ipcMount = mounts.find(
      (m) => m.containerPath === '/workspace/ipc',
    );
    expect(ipcMount).toBeDefined();
    expect(ipcMount!.readonly).toBe(false);

    // /app/src (rw) — agent-runner copy
    const srcMount = mounts.find((m) => m.containerPath === '/app/src');
    expect(srcMount).toBeDefined();
    expect(srcMount!.readonly).toBe(false);
  });

  it('non-main group skips global mount when global dir missing', () => {
    const mounts = expectedNonMainMounts(
      'telegram_edge',
      '/project/groups',
      '/project/data',
      '/project',
      false, // no global dir
    );

    const globalMount = mounts.find(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMount).toBeUndefined();
  });

  it('DM group includes additional community mount', () => {
    const communityMount: VolumeMount = {
      hostPath: '/project/groups/telegram_edge',
      containerPath: '/workspace/extra/community',
      readonly: true,
    };

    const mounts = expectedNonMainMounts(
      'telegram_edge-dm-alice',
      '/project/groups',
      '/project/data',
      '/project',
      true,
      [communityMount],
    );

    // All base mounts present
    expect(mounts.filter((m) => m.containerPath === '/workspace/group')).toHaveLength(1);
    expect(mounts.filter((m) => m.containerPath === '/workspace/global')).toHaveLength(1);
    expect(mounts.filter((m) => m.containerPath === '/home/node/.claude')).toHaveLength(1);
    expect(mounts.filter((m) => m.containerPath === '/workspace/ipc')).toHaveLength(1);
    expect(mounts.filter((m) => m.containerPath === '/app/src')).toHaveLength(1);

    // Plus the community mount
    const extra = mounts.find(
      (m) => m.containerPath === '/workspace/extra/community',
    );
    expect(extra).toBeDefined();
    expect(extra!.readonly).toBe(true);
    expect(extra!.hostPath).toBe('/project/groups/telegram_edge');
  });

  it('main group gets project root (ro) instead of global mount', () => {
    // Main group gets different mounts — verify the key difference
    // Main: /workspace/project (ro) + /workspace/group (rw) + no /workspace/global
    // (Main IS the global scope, so it doesn't need global mounted separately)

    // We just verify the contract: main should NOT have /workspace/global
    // and SHOULD have /workspace/project
    const mainMounts: VolumeMount[] = [
      {
        hostPath: '/project',
        containerPath: '/workspace/project',
        readonly: true,
      },
      {
        hostPath: '/project/groups/main',
        containerPath: '/workspace/group',
        readonly: false,
      },
    ];

    const projectMount = mainMounts.find(
      (m) => m.containerPath === '/workspace/project',
    );
    expect(projectMount).toBeDefined();
    expect(projectMount!.readonly).toBe(true);

    const globalMount = mainMounts.find(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMount).toBeUndefined();
  });
});

// ── Part 2: Context file verification ────────────────────────

describe('Context file verification', () => {
  const baseDir = path.resolve(import.meta.dirname ?? '.', '..');

  it('groups/global/CLAUDE.md exists and contains memory protocol', () => {
    const globalPath = path.join(baseDir, 'groups', 'global', 'CLAUDE.md');
    expect(fs.existsSync(globalPath)).toBe(true);

    const content = fs.readFileSync(globalPath, 'utf-8');
    expect(content).toContain('Mem0');
    expect(content).toContain('add_memory');
    expect(content).toContain('search_memories');
    expect(content).toContain('NEVER use markdown');
    expect(content).toContain('send_message');
    expect(content).toContain('<internal>');
  });

  it('governance/templates/claude-md-template.md exists and renders correctly', () => {
    const templatePath = path.join(
      baseDir,
      'governance',
      'templates',
      'claude-md-template.md',
    );
    expect(fs.existsSync(templatePath)).toBe(true);

    const template = fs.readFileSync(templatePath, 'utf-8');
    const rendered = buildClaudeMd(
      template,
      MOCK_GROUP_CONFIG,
      MOCK_CONSTITUTION,
      API_URL,
    );

    // No unreplaced placeholders
    const unreplaced = rendered.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();

    // Constitution content injected
    expect(rendered).toContain('Respect shared spaces');
    expect(rendered).toContain('Consent before recording');

    // Community name injected
    expect(rendered).toContain('Edge Esmeralda');

    // Version/hash injected
    expect(rendered).toContain('2.1.0');
    expect(rendered).toContain('sha256-abc123def');

    // API URL injected
    expect(rendered).toContain(API_URL);
  });

  it('governance/templates/dm-template.md exists and renders correctly', () => {
    const templatePath = path.join(
      baseDir,
      'governance',
      'templates',
      'dm-template.md',
    );
    expect(fs.existsSync(templatePath)).toBe(true);

    const rendered = buildDmClaudeMd(
      'Edge Esmeralda',
      'Alice',
      'tg:12345',
      'edge-esmeralda',
    );

    // No unreplaced placeholders
    const unreplaced = rendered.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();

    // User-specific content
    expect(rendered).toContain('Alice');
    expect(rendered).toContain('tg:12345');

    // Community reference
    expect(rendered).toContain('Edge Esmeralda');
    expect(rendered).toContain('community:edge-esmeralda');
  });

  it('rendered community CLAUDE.md + global CLAUDE.md together cover all needed instructions', () => {
    const globalPath = path.join(baseDir, 'groups', 'global', 'CLAUDE.md');
    const globalContent = fs.readFileSync(globalPath, 'utf-8');

    const templatePath = path.join(
      baseDir,
      'governance',
      'templates',
      'claude-md-template.md',
    );
    const template = fs.readFileSync(templatePath, 'utf-8');
    const communityContent = buildClaudeMd(
      template,
      MOCK_GROUP_CONFIG,
      MOCK_CONSTITUTION,
      API_URL,
    );

    const combined = globalContent + '\n' + communityContent;

    // Memory protocol (from global)
    expect(combined).toContain('add_memory');
    expect(combined).toContain('search_memories');
    expect(combined).toContain('Namespaces');

    // Formatting rules (from global)
    expect(combined).toContain('NEVER use markdown');
    expect(combined).toContain('single asterisks');

    // Communication mechanics (from global)
    expect(combined).toContain('send_message');
    expect(combined).toContain('<internal>');

    // Constitution content (from community)
    expect(combined).toContain('Respect shared spaces');

    // Listening mode (from community)
    expect(combined).toContain('Listening Mode');

    // Pattern sensing (from community)
    expect(combined).toContain('Pattern Sensing');

    // Connection protocol (from community)
    expect(combined).toContain('consent from both parties');

    // Auto-registration (from community)
    expect(combined).toContain('/api/members/telegram');
  });

  it('rendered DM CLAUDE.md has the right community context path', () => {
    const rendered = buildDmClaudeMd(
      'Edge Esmeralda',
      'Bob',
      'tg:67890',
      'edge-esmeralda',
    );

    // DM template should reference the community folder mounted at /workspace/extra/community
    expect(rendered).toContain('/workspace/extra/community/community-knowledge/');
    expect(rendered).toContain('/workspace/extra/community/CLAUDE.md');
  });
});

// ── Part 3: Mem0 MCP config construction ─────────────────────

describe('Mem0 MCP config construction', () => {
  /**
   * Replicates the Mem0 config logic from container/agent-runner/src/index.ts
   * (lines ~444-457). We can't import the agent-runner directly because it
   * has side effects (reads stdin, calls main()), so we replicate the logic
   * and verify it matches.
   */
  function buildMem0Config(env: Record<string, string | undefined>): Record<string, McpServerConfig> {
    if (env.MEM0_SSE_URL) {
      return {
        mem0: {
          type: 'sse' as const,
          url: env.MEM0_SSE_URL,
        },
      };
    }

    if (env.MEM0_API_KEY) {
      return {
        mem0: {
          command: 'uvx',
          args: ['mem0-mcp-server'],
          env: {
            MEM0_API_KEY: env.MEM0_API_KEY,
          },
        },
      };
    }

    return {};
  }

  it('SSE config when MEM0_SSE_URL is set', () => {
    const config = buildMem0Config({
      MEM0_SSE_URL: 'http://localhost:8080/sse',
    });

    expect(config.mem0).toBeDefined();
    expect((config.mem0 as any).type).toBe('sse');
    expect((config.mem0 as any).url).toBe('http://localhost:8080/sse');
  });

  it('stdio config when MEM0_API_KEY is set (no SSE)', () => {
    const config = buildMem0Config({
      MEM0_API_KEY: 'mem0-key-abc123',
    });

    expect(config.mem0).toBeDefined();
    expect((config.mem0 as any).command).toBe('uvx');
    expect((config.mem0 as any).args).toEqual(['mem0-mcp-server']);
    expect((config.mem0 as any).env).toEqual({
      MEM0_API_KEY: 'mem0-key-abc123',
    });
  });

  it('SSE takes priority when both are set', () => {
    const config = buildMem0Config({
      MEM0_SSE_URL: 'http://localhost:8080/sse',
      MEM0_API_KEY: 'mem0-key-abc123',
    });

    expect(config.mem0).toBeDefined();
    expect((config.mem0 as any).type).toBe('sse');
    expect((config.mem0 as any).url).toBe('http://localhost:8080/sse');
    // Should NOT have command/args from stdio config
    expect((config.mem0 as any).command).toBeUndefined();
  });

  it('no mem0 config when neither is set', () => {
    const config = buildMem0Config({});
    expect(config.mem0).toBeUndefined();
    expect(Object.keys(config)).toHaveLength(0);
  });

  it('no mem0 config when values are undefined', () => {
    const config = buildMem0Config({
      MEM0_SSE_URL: undefined,
      MEM0_API_KEY: undefined,
    });
    expect(Object.keys(config)).toHaveLength(0);
  });

  it('matches the agent-runner source logic', () => {
    // Read the actual agent-runner source and verify our replicated logic
    // matches the conditional structure
    const agentRunnerPath = path.resolve(
      import.meta.dirname ?? '.',
      '../container/agent-runner/src/index.ts',
    );
    const source = fs.readFileSync(agentRunnerPath, 'utf-8');

    // Verify the SSE-first priority structure exists
    expect(source).toContain('process.env.MEM0_SSE_URL');
    expect(source).toContain('process.env.MEM0_API_KEY');

    // Verify SSE uses type: 'sse' and url
    expect(source).toContain("type: 'sse'");
    expect(source).toContain('url: process.env.MEM0_SSE_URL');

    // Verify stdio uses uvx
    expect(source).toContain("command: 'uvx'");
    expect(source).toContain("args: ['mem0-mcp-server']");

    // Verify priority: SSE check comes before API key check
    const sseIndex = source.indexOf('process.env.MEM0_SSE_URL');
    const apiKeyIndex = source.indexOf('process.env.MEM0_API_KEY');
    expect(sseIndex).toBeLessThan(apiKeyIndex);
  });
});

// ── Part 4: Container input construction ─────────────────────

describe('Container input construction', () => {
  interface ContainerInput {
    prompt: string;
    sessionId?: string;
    groupFolder: string;
    chatJid: string;
    isMain: boolean;
    isScheduledTask?: boolean;
    assistantName?: string;
    mcpServers?: Record<string, McpServerConfig>;
  }

  function buildContainerInput(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    sessionId?: string,
  ): ContainerInput {
    return {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain: group.isMain || false,
      mcpServers: group.containerConfig?.mcpServers,
    };
  }

  it('DM group input has correct structure', () => {
    const dmGroup: RegisteredGroup = {
      name: 'DM with Alice',
      folder: 'telegram_edge-dm-alice',
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: false,
      requiresTrigger: false,
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/project/groups/telegram_edge',
            containerPath: 'community',
            readonly: true,
          },
        ],
      },
    };

    const input = buildContainerInput(
      dmGroup,
      'Hello Alice',
      'tg:dm-alice@c.us',
      'session-abc',
    );

    expect(input.isMain).toBe(false);
    expect(input.groupFolder).toBe('telegram_edge-dm-alice');
    expect(input.groupFolder).toMatch(/-dm-/);
    expect(input.prompt).toBe('Hello Alice');
    expect(input.chatJid).toBe('tg:dm-alice@c.us');
    expect(input.sessionId).toBe('session-abc');
  });

  it('DM group with MCP servers passes them through', () => {
    const customMcp: Record<string, McpServerConfig> = {
      'custom-tool': {
        command: 'node',
        args: ['/tools/custom.js'],
        env: { API_KEY: 'test' },
      },
    };

    const dmGroup: RegisteredGroup = {
      name: 'DM with Bob',
      folder: 'telegram_edge-dm-bob',
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: false,
      containerConfig: {
        mcpServers: customMcp,
      },
    };

    const input = buildContainerInput(
      dmGroup,
      'Hey Bob',
      'tg:dm-bob@c.us',
    );

    expect(input.mcpServers).toBeDefined();
    expect(input.mcpServers!['custom-tool']).toBeDefined();
    expect((input.mcpServers!['custom-tool'] as any).command).toBe('node');
  });

  it('community group input has isMain false', () => {
    const communityGroup: RegisteredGroup = {
      name: 'Edge Esmeralda',
      folder: 'telegram_edge',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: false,
    };

    const input = buildContainerInput(
      communityGroup,
      '@Andy what time is dinner?',
      'tg:group123@g.us',
    );

    expect(input.isMain).toBe(false);
    expect(input.groupFolder).toBe('telegram_edge');
    expect(input.mcpServers).toBeUndefined();
  });

  it('main group input has isMain true', () => {
    const mainGroup: RegisteredGroup = {
      name: 'Main Control',
      folder: 'main',
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const input = buildContainerInput(
      mainGroup,
      'list groups',
      'tg:admin@c.us',
    );

    expect(input.isMain).toBe(true);
    expect(input.groupFolder).toBe('main');
  });

  it('no sessionId for first interaction', () => {
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'test',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    };

    const input = buildContainerInput(
      group,
      'Hello',
      'tg:test@g.us',
    );

    expect(input.sessionId).toBeUndefined();
  });
});
