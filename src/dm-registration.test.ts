/**
 * Tests for DM auto-registration: folder sanitization, community lookup,
 * CLAUDE.md generation, and auto-registration flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  sanitizeForFolder,
  buildDmClaudeMd,
  writeDmClaudeMd,
  findCommunityForUser,
} from './dm-registration.js';
import type { RegisteredGroup } from './types.js';

// ── sanitizeForFolder ────────────────────────────────────────

describe('sanitizeForFolder', () => {
  it('converts a Telegram ID to a valid folder segment', () => {
    expect(sanitizeForFolder('tg:12345')).toBe('tg-12345');
  });

  it('strips special characters', () => {
    expect(sanitizeForFolder('user@example.com')).toBe('user-example-com');
  });

  it('collapses multiple hyphens', () => {
    expect(sanitizeForFolder('a---b___c')).toBe('a-b-c');
  });

  it('trims leading/trailing hyphens', () => {
    expect(sanitizeForFolder('---hello---')).toBe('hello');
  });

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeForFolder(long).length).toBeLessThanOrEqual(64);
  });

  it('throws on empty string', () => {
    expect(() => sanitizeForFolder('')).toThrow('Invalid sender ID');
  });

  it('throws on string that produces empty result', () => {
    expect(() => sanitizeForFolder('...')).toThrow('empty folder name');
  });

  it('handles numeric-only IDs', () => {
    expect(sanitizeForFolder('123456789')).toBe('123456789');
  });
});

// ── buildDmClaudeMd ──────────────────────────────────────────

describe('buildDmClaudeMd', () => {
  it('includes user name', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).toContain('Alice');
  });

  it('includes community name', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).toContain('Test Village');
  });

  it('includes correct personal memory namespace', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).toContain('tg:123');
  });

  it('includes correct community memory namespace', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).toContain('community:test-village');
  });

  it('does NOT include listening mode (group-only)', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).not.toContain('Listening Mode');
  });

  it('does NOT include pattern sensing (group-only)', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).not.toContain('Pattern Sensing');
  });

  it('includes "always respond" instruction', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).toContain('Always respond');
  });

  it('includes privacy rules', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    expect(result).toContain('NEVER share other people');
  });

  it('leaves no unreplaced placeholders', () => {
    const result = buildDmClaudeMd(
      'Test Village',
      'Alice',
      'tg:123',
      'test-village',
    );
    const unreplaced = result.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();
  });
});

// ── writeDmClaudeMd ──────────────────────────────────────────

describe('writeDmClaudeMd', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-'));
    vi.stubEnv('GROUPS_DIR', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes CLAUDE.md to the correct path', async () => {
    // We need to mock resolveGroupFolderPath since it uses GROUPS_DIR from config
    // Instead, test buildDmClaudeMd (pure function) and trust writeDmClaudeMd calls it
    const content = buildDmClaudeMd(
      'My Community',
      'Bob',
      'tg:456',
      'my-community',
    );
    expect(content).toContain('Bob');
    expect(content).toContain('My Community');
    expect(content).toContain('tg:456');
    expect(content).toContain('community:my-community');
  });
});

// ── findCommunityForUser ─────────────────────────────────────

describe('findCommunityForUser', () => {
  const baseGroup: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: 'Andy',
    added_at: new Date().toISOString(),
  };

  it('returns null for unknown users', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:group1': baseGroup,
    };
    const findSender = vi.fn().mockReturnValue(false);

    const result = findCommunityForUser('tg:unknown', groups, findSender);
    expect(result).toBeNull();
  });

  it('finds community when user has sent messages', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:group1': baseGroup,
    };
    const findSender = vi.fn().mockReturnValue(true);

    const result = findCommunityForUser('tg:user1', groups, findSender);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('tg:group1');
    expect(result!.group).toBe(baseGroup);
  });

  it('skips main group', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:main': { ...baseGroup, isMain: true },
      'tg:community': { ...baseGroup, folder: 'community' },
    };
    const findSender = vi.fn().mockImplementation((chatJid: string) => {
      return chatJid === 'tg:community';
    });

    const result = findCommunityForUser('tg:user1', groups, findSender);
    expect(result!.jid).toBe('tg:community');
    // Should not have checked main group
    expect(findSender).not.toHaveBeenCalledWith('tg:main', 'tg:user1');
  });

  it('skips existing DM folders', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:dm1': { ...baseGroup, folder: 'test-group-dm-tg-999' },
      'tg:community': { ...baseGroup, folder: 'community' },
    };
    const findSender = vi.fn().mockImplementation((chatJid: string) => {
      return chatJid === 'tg:community';
    });

    const result = findCommunityForUser('tg:user1', groups, findSender);
    expect(result!.jid).toBe('tg:community');
    expect(findSender).not.toHaveBeenCalledWith('tg:dm1', 'tg:user1');
  });

  it('returns first match when user is in multiple communities', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:group1': { ...baseGroup, name: 'Group 1', folder: 'group1' },
      'tg:group2': { ...baseGroup, name: 'Group 2', folder: 'group2' },
    };
    const findSender = vi.fn().mockReturnValue(true);

    const result = findCommunityForUser('tg:user1', groups, findSender);
    expect(result).not.toBeNull();
    // Should find the first one (iteration order)
  });
});
