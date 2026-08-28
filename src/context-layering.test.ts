/**
 * Tests for context layering: global CLAUDE.md, community template, DM template.
 * Verifies correct separation of concerns across the three layers.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildClaudeMd,
  type ConstitutionData,
} from '../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../governance/sync/config.js';
import { buildDmClaudeMd } from './dm-registration.js';

// ── Load templates ───────────────────────────────────────────

const GLOBAL_CLAUDE_MD = fs.readFileSync(
  path.resolve(import.meta.dirname ?? '.', '../groups/global/CLAUDE.md'),
  'utf-8',
);

const COMMUNITY_TEMPLATE = fs.readFileSync(
  path.resolve(
    import.meta.dirname ?? '.',
    '../governance/templates/claude-md-template.md',
  ),
  'utf-8',
);

const DM_TEMPLATE = fs.readFileSync(
  path.resolve(
    import.meta.dirname ?? '.',
    '../governance/templates/dm-template.md',
  ),
  'utf-8',
);

const MOCK_GROUP: GroupConfig = {
  folder: 'telegram_test',
  slug: 'test-community',
  community_name: 'Test Community',
  admin_id: 'tg:admin1',
  admin_name: 'TestAdmin',
  crew_list: 'TestAdmin (tg:admin1)',
  assistant_name: 'Andy',
  community_start_date: '2026-03-15',
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
    expect(GLOBAL_CLAUDE_MD).toContain(
      "NEVER share one user's personal memories",
    );
    expect(GLOBAL_CLAUDE_MD).toContain('Community memories are shared');
  });

  it('contains memory metadata type tags including norm', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('`wish`');
    expect(GLOBAL_CLAUDE_MD).toContain('`concern`');
    expect(GLOBAL_CLAUDE_MD).toContain('`fact`');
    expect(GLOBAL_CLAUDE_MD).toContain('`connection`');
    expect(GLOBAL_CLAUDE_MD).toContain('`norm`');
  });

  it('contains tier metadata and conflict resolution', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('`operational`');
    expect(GLOBAL_CLAUDE_MD).toContain('`social`');
    expect(GLOBAL_CLAUDE_MD).toContain('Conflict Resolution by Tier');
    expect(GLOBAL_CLAUDE_MD).toContain('Last-writer-wins');
    expect(GLOBAL_CLAUDE_MD).toContain('Hold both sides');
    expect(GLOBAL_CLAUDE_MD).toContain('Flag for humans');
  });

  it('contains source_context metadata', () => {
    expect(GLOBAL_CLAUDE_MD).toContain('`source_context`');
    expect(GLOBAL_CLAUDE_MD).toContain('`group`');
  });

  it('does NOT contain community-specific content', () => {
    expect(GLOBAL_CLAUDE_MD).not.toContain('{{community_name}}');
    expect(GLOBAL_CLAUDE_MD).not.toContain('{{slug}}');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Listening Mode');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Pattern Sensing');
    // "constitutional" appears in tier descriptions (that's global), but not constitution content
    expect(GLOBAL_CLAUDE_MD).not.toContain('## Constitution');
  });

  it('does NOT contain DM-specific instructions', () => {
    expect(GLOBAL_CLAUDE_MD).not.toContain('Private Conversation');
    expect(GLOBAL_CLAUDE_MD).not.toContain('Always respond');
  });
});

// ── Layer 2: Community template ──────────────────────────────

describe('Community template (Layer 2)', () => {
  const rendered = buildClaudeMd(
    COMMUNITY_TEMPLATE,
    MOCK_GROUP,
    MOCK_DATA,
    'https://emergentvibe.com',
  );

  it('contains tag-only response model', () => {
    expect(rendered).toContain('When You Speak');
    expect(rendered).toContain('silence');
  });

  it('contains pattern sensing', () => {
    expect(rendered).toContain('Pattern Sensing');
    expect(rendered).toContain('2+ people');
  });

  it('contains "What You Never Do" section', () => {
    expect(rendered).toContain('What You Never Do');
    expect(rendered).toContain("Don't respond unless addressed");
  });

  it('contains onboarding section with operational categories', () => {
    expect(rendered).toContain('Onboarding');
    expect(rendered).toContain('spaces');
    expect(rendered).toContain('meals');
    expect(rendered).toContain('events');
    expect(rendered).toContain('contacts');
  });

  it('contains crew section with crew list', () => {
    expect(rendered).toContain('Crew');
    expect(rendered).toContain('TestAdmin (tg:admin1)');
  });

  it('contains epistemic markers', () => {
    expect(rendered).toContain('How You Speak About What You Know');
    expect(rendered).toContain('Established fact');
    expect(rendered).toContain("I've heard that");
    expect(rendered).toContain('A few people have mentioned');
  });

  it('contains knowledge tiers', () => {
    expect(rendered).toContain('Knowledge Tiers and Conflict Resolution');
    expect(rendered).toContain('operational');
    expect(rendered).toContain('social');
  });

  it('contains first-person authority', () => {
    expect(rendered).toContain('First-Person Authority');
    expect(rendered).toContain('absolute authority');
  });

  it('contains anti-inference rule', () => {
    expect(rendered).toContain(
      "Don't infer and store things people didn't say",
    );
  });

  it('contains tension awareness', () => {
    expect(rendered).toContain('Tensions You Ship With');
    expect(rendered).toContain('Legibility creep');
    expect(rendered).toContain('Pattern sensing creates norms');
  });

  it('contains seven MVG rules', () => {
    expect(rendered).toContain('Seven MVG Rules');
    expect(rendered).toContain('Anyone can contribute knowledge');
  });

  it('references community memory instead of files', () => {
    expect(rendered).toContain('community:test-community');
    expect(rendered).not.toContain('community-knowledge/');
  });

  it('does not contain auto-registration (removed for treeweek)', () => {
    expect(rendered).not.toContain('POST');
    expect(rendered).not.toContain('Auto-Registration');
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
  const rendered = buildDmClaudeMd(
    'Test Village',
    'Alice',
    'tg:123',
    'test-village',
    'tg:admin1',
    '2026-03-15',
  );

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

  it('uses tier-based authority', () => {
    expect(rendered).toContain('Knowledge Authority');
    expect(rendered.toLowerCase()).toContain('operational');
    expect(rendered.toLowerCase()).toContain('social');
  });

  it('includes crew info', () => {
    expect(rendered).toContain('Crew');
    expect(rendered).toContain('tg:admin1');
  });

  it('includes first-person authority', () => {
    expect(rendered).toContain('First-Person Authority');
    expect(rendered).toContain('absolute authority');
  });

  it('includes onboarding for crew only', () => {
    expect(rendered).toContain('Onboarding');
    expect(rendered).toContain('Crew Only');
    expect(rendered).toContain('seed knowledge');
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

  it('response model only in community template', () => {
    expect(COMMUNITY_TEMPLATE).toContain('When You Speak');
    expect(GLOBAL_CLAUDE_MD).not.toContain('When You Speak');
    expect(DM_TEMPLATE).not.toContain('When You Speak');
  });
});
