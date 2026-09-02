import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { renderClaudeMd, validateRendered } from './render-claude-md.js';

const TEMPLATE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../governance/templates'
);

const mockConstitution = {
  slug: 'test-community',
  name: 'Test Community',
  content: '## Principles\n\n1. Be excellent',
  version: '1',
  content_hash: 'abc123',
  updated_at: '2026-03-20T00:00:00Z',
};

const renderOpts = {
  communityName: 'Test Community',
  userName: 'alice',
  adminId: 'tg:12345',
  adminName: 'Bob',
  communityStartDate: '2026-03-20',
  constitution: mockConstitution,
  apiUrl: 'https://emergentvibe.com',
  mem0Url: 'http://localhost:8765/sse',
};

describe('Template rendering — all templates', () => {
  it('claude-code-template.md renders with no unreplaced variables', () => {
    const template = readFileSync(path.join(TEMPLATE_DIR, 'claude-code-template.md'), 'utf-8');
    const rendered = renderClaudeMd(template, renderOpts);
    const unreplaced = validateRendered(rendered);
    expect(unreplaced).toEqual([]);
  });

  it('claude-md-template.md renders with remaining group-specific variables only', () => {
    const template = readFileSync(path.join(TEMPLATE_DIR, 'claude-md-template.md'), 'utf-8');
    const rendered = renderClaudeMd(template, renderOpts);
    const unreplaced = validateRendered(rendered);
    // The community template has {{polis_url}} which isn't in renderClaudeMd — that's OK,
    // it's set by constitution-sync.ts not by the join CLI
    const expectedUnreplaced = unreplaced.filter(v => v !== '{{polis_url}}');
    expect(expectedUnreplaced).toEqual([]);
  });

  it('dm-template.md renders with remaining DM-specific variables only', () => {
    const template = readFileSync(path.join(TEMPLATE_DIR, 'dm-template.md'), 'utf-8');
    const rendered = renderClaudeMd(template, renderOpts);
    const unreplaced = validateRendered(rendered);
    // DM template has {{user_id}} which is Telegram-specific — not set by join CLI
    const expectedUnreplaced = unreplaced.filter(v => v === '{{user_id}}');
    // All other variables should be replaced
    const unexpected = unreplaced.filter(v => v !== '{{user_id}}');
    expect(unexpected).toEqual([]);
  });
});
