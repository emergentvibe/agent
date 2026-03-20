/**
 * Tests for context layering: global CLAUDE.md, community template, DM template.
 * Verifies correct separation of concerns across the three layers.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildClaudeMd, type ConstitutionData } from '../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../governance/sync/config.js';
import { buildDmClaudeMd } from './dm-registration.js';

// ── Load templates ───────────────────────────────────────────

const GLOBAL_CLAUDE_MD = fs.readFileSync(
  path.resolve(import.meta.dirname ?? '.', '../groups/global/CLAUDE.md'),
  'utf-8',
);

const COMMUNITY_TEMPLATE = fs.readFileSync(
  path.resolve(import.meta.dirname ?? '.', '../governance/templates/claude-md-template.md'),
  'utf-8',
);

const DM_TEMPLATE = fs.readFileSync(
  path.resolve(import.meta.dirname ?? '.', '../governance/templates/dm-template.md'),
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
  content_hash: 'abc123',
  updated_at: '2026-03-18T12:00:00Z',
};

// ── Layer 1: Global CLAUDE.md ────────────────────────────────

describe('Global CLAUDE.md (Layer 1)', () => {
  it('contains memory protocol', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('Mem0');
    expect(GLOBAL_CLAUDE_MD).toContain('add_memory');
    expect(GLOBAL_CLAUDE_MD).toContain('search_memories');
  });

  it('contains formatting rules', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('NEVER use markdown');
    expect(GLOBAL_CLAUDE_MD).toContain('single asterisks');
  });

  it('contains communication mechanics', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('send_message');
    expect(GLOBAL_CLAUDE_MD).toContain('<internal>');
  });

  it('contains privacy rules', () => {
    expect(GLOBAL_CLAUDE_MD).toContain("NEVER share one user's personal memories");
    expect(GLOBAL_CLAUDE_MD).toContain('Community memories are shared');
  });

  it('contains memory metadata type tags', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('"type": "wish"');
    expect(GLOBAL_CLAUDE_MD).toContain('"type": "concern"');
    expect(GLOBAL_CLAUDE_MD).toContain('"type": "fact"');
    expect(GLOBAL_CLAUDE_MD).toContain('"type": "connection"');
  });

  it('does NOT contain community-specific content', () => {
    expect(GLOBAL_CLAUDE_MD).not.toContain('{{community_name}}');
    expect(GLOBAL_CLAUDE_MD).not.toContain('{{slug}}');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Listening Mode');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Pattern Sensing');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Constitution');
  });

  it('does NOT contain DM-specific instructions', () => {
    expect(GLOBAL_CLAUDE_MD).not.toContain('Private Conversation');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Always respond');
  });
});

// ── Layer 2: Community template ──────────────────────────────

describe('Community template (Layer 2)', () => {
  const rendered = buildClaudeMd(COMMUNITY_TEMPLATE, MOCK_GROUP, MOCK_DATA, 'https://emergentvibe.com');

  it('renders with constitution content', () => {
    expect(rendered).toContain('1. Do no harm');
    expect(rendered).toContain('2. Be excellent to each other');
  });

  it('frames constitution as reference principles', () => {
    expect(rendered).toContain('These principles guide your values');
    expect(rendered).toContain('written by the community');
  });

  it('contains listening mode', () => {
    expect(rendered).toContain('Listening Mode');
    expect(rendered).toContain('silence');
  });

  it('contains pattern sensing', () => {
    expect(rendered).toContain('Pattern Sensing');
    expect(rendered).toContain('3+ people');
  });

  it('contains connection protocol', () => {
    expect(rendered).toContain('Connection');
    expect(rendered).toContain('consent from both parties');
  });

  it('contains "What You Never Do" section', () => {
    expect(rendered).toContain('What You Never Do');
    expect(rendered).toContain("Don't respond to every message");
  });

  it('contains auto-registration instructions', () => {
    expect(rendered).toContain('POST https://emergentvibe.com/api/members/telegram');
    expect(rendered).toContain('constitution_slug: "test-community"');
  });

  it('does NOT contain memory protocol (that is in global)', () => {
    // Memory *usage* examples (search_memories) are OK, but the full protocol/rules belong in global
    expect(rendered).not.toContain('Privacy Rules (Non-Negotiable)');
    expect(rendered).not.toContain("NEVER share one user's personal memories");
  });

  it('does NOT contain formatting rules (that is in global)', () => {
    expect(rendered).not.toContain('NEVER use markdown');
    expect(rendered).not.toContain('single asterisks');
  });

  it('leaves no unreplaced placeholders', () => {
    const unreplaced = rendered.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();
  });
});

// ── Layer 3: DM template ─────────────────────────────────────

describe('DM template (Layer 3)', () => {
  const rendered = buildDmClaudeMd('Test Village', 'Alice', 'tg:123', 'test-village');

  it('identifies as private conversation', () => {
    expect(rendered).toContain('Private Conversation');
    expect(rendered).toContain('Alice');
  });

  it('says always respond', () => {
    expect(rendered).toContain('Always respond');
  });

  it('includes personal + community memory search', () => {
    expect(rendered).toContain('tg:123');
    expect(rendered).toContain('community:test-village');
  });

  it('includes community context path', () => {
    expect(rendered).toContain('/workspace/extra/community/community-knowledge/');
  });

  it('includes privacy rules', () => {
    expect(rendered).toContain('NEVER share other people');
  });

  it('does NOT contain listening mode (group-only)', () => {
    expect(rendered).not.toContain('Listening Mode');
  });

  it('does NOT contain pattern sensing (group-only)', () => {
    expect(rendered).not.toContain('Pattern Sensing');
  });

  it('leaves no unreplaced placeholders', () => {
    const unreplaced = rendered.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();
  });
});

// ── Cross-layer separation ───────────────────────────────────

describe('Cross-layer separation', () => {
  it('memory protocol only in global (not in community or DM templates)', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('Namespaces');

    // Community template should not duplicate the full memory protocol
    expect(COMMUNITY_TEMPLATE).not.toContain('Namespaces');
    expect(DM_TEMPLATE).not.toContain('Namespaces');
  });

  it('formatting rules only in global', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('NEVER use markdown');
    expect(COMMUNITY_TEMPLATE).not.toContain('NEVER use markdown');
    expect(DM_TEMPLATE).not.toContain('NEVER use markdown');
  });

  it('listening mode only in community template', () => {
    expect(COMMUNITY_TEMPLATE).toContain('Listening Mode');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Listening Mode');
    expect(DM_TEMPLATE).not.toContain('Listening Mode');
  });
});
