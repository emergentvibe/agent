import { describe, it, expect } from 'vitest';
import { renderClaudeMd, validateRendered } from './render-claude-md.js';
import { configureMcp } from './configure-mcp.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockConstitution = {
  slug: 'test-community',
  name: 'Test Community',
  content: '## Principles\n\n1. Be excellent to each other',
  version: '1',
  content_hash: 'abc123',
  updated_at: '2026-03-20T00:00:00Z',
};

const sampleTemplate = `# {{community_name}} — Community Member

You're assisting a member of **{{community_name}}**.

Community started: {{community_start_date}}
Bootstrapper: {{admin_name}} ({{admin_id}})

Version: {{principles_version}} | Hash: {{principles_hash}}
Last updated: {{principles_updated_at}}
Last synced: {{last_sync_time}}

{{principles_content}}

{{charter_content}}

Community: {{emergentvibe_url}}/c/{{slug}}

Personal memory: cc:{{user_name}}
`;

describe('renderClaudeMd', () => {
  it('replaces all template variables', () => {
    const rendered = renderClaudeMd(sampleTemplate, {
      communityName: 'Test Community',
      userName: 'alice',
      adminId: 'tg:12345',
      adminName: 'Bob',
      communityStartDate: '2026-03-20',
      constitution: mockConstitution,
      apiUrl: 'https://emergentvibe.com',
      mem0Url: 'http://localhost:8765/sse',
    });

    expect(rendered).toContain('Test Community');
    expect(rendered).toContain('2026-03-20');
    expect(rendered).toContain('Bob');
    expect(rendered).toContain('tg:12345');
    expect(rendered).toContain('Be excellent to each other');
    expect(rendered).toContain('https://emergentvibe.com/c/test-community');
    expect(rendered).toContain('cc:alice');

    const unreplaced = validateRendered(rendered);
    expect(unreplaced).toEqual([]);
  });

  it('handles missing content_hash', () => {
    const rendered = renderClaudeMd(sampleTemplate, {
      communityName: 'Test',
      userName: 'alice',
      adminId: 'admin',
      adminName: 'Admin',
      communityStartDate: '2026-01-01',
      constitution: { ...mockConstitution, content_hash: null },
      apiUrl: 'https://emergentvibe.com',
      mem0Url: 'http://localhost:8765/sse',
    });

    expect(rendered).toContain('Hash: unknown');
  });
});

describe('validateRendered', () => {
  it('detects unreplaced variables', () => {
    const result = validateRendered('Hello {{name}}, welcome to {{community_name}}');
    expect(result).toContain('{{name}}');
    expect(result).toContain('{{community_name}}');
  });

  it('returns empty array when all replaced', () => {
    const result = validateRendered('Hello Alice, welcome to Test Community');
    expect(result).toEqual([]);
  });

  it('deduplicates repeated unreplaced variables', () => {
    const result = validateRendered('{{name}} and {{name}} again');
    expect(result).toEqual(['{{name}}']);
  });
});

describe('configureMcp', () => {
  it('creates settings with mem0 server config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-test-'));
    try {
      configureMcp(tmpDir, 'http://localhost:8765/sse');

      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.mcpServers.mem0).toEqual({
        type: 'sse',
        url: 'http://localhost:8765/sse',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('preserves existing settings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-test-'));
    try {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({ someKey: 'value', mcpServers: { other: { command: 'test' } } }),
        'utf-8'
      );

      configureMcp(tmpDir, 'http://localhost:8765/sse');

      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
      expect(settings.someKey).toBe('value');
      expect(settings.mcpServers.other).toEqual({ command: 'test' });
      expect(settings.mcpServers.mem0).toEqual({
        type: 'sse',
        url: 'http://localhost:8765/sse',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
