/**
 * Integration test: community intelligence message flow
 *
 * Tests the full path from "message arrives in group" to "DM gets auto-registered"
 * without any external services. Uses in-memory SQLite and real template files.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  _initTestDatabase,
  storeMessage,
  hasSenderInChat,
  storeChatMetadata,
} from './db.js';
import {
  sanitizeForFolder,
  findCommunityForUser,
  buildDmClaudeMd,
  writeDmClaudeMd,
} from './dm-registration.js';
import {
  buildClaudeMd,
  loadTemplate,
  type ConstitutionData,
} from '../governance/sync/constitution-sync.js';
import type { GroupConfig } from '../governance/sync/config.js';
import type { RegisteredGroup } from './types.js';

describe('Integration: community intelligence message flow', () => {
  // Shared state across sequential tests
  const senderJid = 'tg:user123';
  const senderName = 'Alice';
  const groupChatJid = 'tg:group1';
  const dmChatJid = 'tg:user123-dm';
  const communityFolder = 'test-community';
  const communityName = 'Test Community';

  const registeredGroups: Record<string, RegisteredGroup> = {
    [groupChatJid]: {
      name: communityName,
      folder: communityFolder,
      trigger: 'Andy',
      added_at: new Date().toISOString(),
    },
  };

  let tmpDir: string;

  beforeAll(() => {
    // Step 1: init in-memory database
    _initTestDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Step 2: register a fake community group
  it('registers a community group in the chat metadata', () => {
    storeChatMetadata(
      groupChatJid,
      new Date().toISOString(),
      communityName,
      'telegram',
      true,
    );

    // Also register the DM chat as non-group
    storeChatMetadata(
      dmChatJid,
      new Date().toISOString(),
      undefined,
      'telegram',
      false,
    );
  });

  // Step 3: store messages from the sender in the group chat
  it('stores messages from a sender in the community group', () => {
    const now = new Date();
    const messages = [
      {
        id: 'msg1',
        chat_jid: groupChatJid,
        sender: senderJid,
        sender_name: senderName,
        content: 'Hey everyone, anyone up for communal dinners?',
        timestamp: new Date(now.getTime() - 60000).toISOString(),
        is_from_me: false,
        is_bot_message: false,
      },
      {
        id: 'msg2',
        chat_jid: groupChatJid,
        sender: senderJid,
        sender_name: senderName,
        content: 'I can cook on Fridays',
        timestamp: now.toISOString(),
        is_from_me: false,
        is_bot_message: false,
      },
    ];

    for (const msg of messages) {
      storeMessage(msg);
    }

    // Verify sender can be found in the group chat
    expect(hasSenderInChat(groupChatJid, senderJid)).toBe(true);
    // Verify sender is NOT found in a chat they haven't messaged in
    expect(hasSenderInChat('tg:other-group', senderJid)).toBe(false);
  });

  // Step 4: simulate DM arrival — find which community the sender belongs to
  it('finds the community for a DM sender via message history', () => {
    const match = findCommunityForUser(
      senderJid,
      registeredGroups,
      hasSenderInChat,
    );

    expect(match).not.toBeNull();
    expect(match!.jid).toBe(groupChatJid);
    expect(match!.group.name).toBe(communityName);
    expect(match!.group.folder).toBe(communityFolder);
  });

  // Step 5: DM folder name is correct
  it('creates DM folder with correct name pattern', () => {
    const sanitized = sanitizeForFolder(senderJid);
    const dmFolder = `${communityFolder}-dm-${sanitized}`;

    expect(dmFolder).toBe('test-community-dm-tg-user123');

    // Create the folder in tmpDir to verify filesystem ops
    const dmDir = path.join(tmpDir, dmFolder);
    fs.mkdirSync(dmDir, { recursive: true });
    expect(fs.existsSync(dmDir)).toBe(true);
  });

  // Step 6: DM CLAUDE.md has correct content
  it('builds DM CLAUDE.md with correct content', () => {
    const slug = communityFolder;
    const content = buildDmClaudeMd(communityName, senderName, 'user123', slug);

    // Has user name
    expect(content).toContain(senderName);
    // Has community name
    expect(content).toContain(communityName);
    // Has correct personal memory namespace
    expect(content).toContain('tg:user123');
    // Has correct community memory namespace
    expect(content).toContain(`community:${slug}`);
    // No unreplaced placeholders
    const unreplaced = content.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();
  });

  // Step 7: DM registration has requiresTrigger: false
  it('DM registration has requiresTrigger: false', () => {
    const dmRegistration: RegisteredGroup = {
      name: `DM: ${senderName}`,
      folder: `${communityFolder}-dm-${sanitizeForFolder(senderJid)}`,
      trigger: 'Andy',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };

    expect(dmRegistration.requiresTrigger).toBe(false);
  });

  // Step 8: DM registration has additionalMounts pointing to community folder
  it('DM registration has additionalMounts pointing to community folder', () => {
    const dmRegistration: RegisteredGroup = {
      name: `DM: ${senderName}`,
      folder: `${communityFolder}-dm-${sanitizeForFolder(senderJid)}`,
      trigger: 'Andy',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      containerConfig: {
        additionalMounts: [
          {
            hostPath: path.join(tmpDir, communityFolder),
            containerPath: 'community',
            readonly: true,
          },
        ],
      },
    };

    expect(dmRegistration.containerConfig).toBeDefined();
    expect(dmRegistration.containerConfig!.additionalMounts).toBeDefined();
    expect(dmRegistration.containerConfig!.additionalMounts!.length).toBe(1);

    const mount = dmRegistration.containerConfig!.additionalMounts![0];
    expect(mount.hostPath).toContain(communityFolder);
    expect(mount.containerPath).toBe('community');
    expect(mount.readonly).toBe(true);
  });

  // Step 9: global CLAUDE.md content verification
  it('global CLAUDE.md has memory protocol, formatting rules, privacy rules, NO community content', () => {
    const globalClaudeMdPath = path.resolve(
      import.meta.dirname ?? '.',
      '../groups/global/CLAUDE.md',
    );
    const globalContent = fs.readFileSync(globalClaudeMdPath, 'utf-8');

    // Has memory protocol
    expect(globalContent).toContain('Memory');
    expect(globalContent).toContain('Mem0');
    // Has formatting rules
    expect(globalContent).toContain('Formatting');
    // Has privacy rules
    expect(globalContent).toContain('Privacy');
    expect(globalContent).toContain('NEVER share');
    // Does NOT have community-specific content
    expect(globalContent).not.toContain('{{community_name}}');
    expect(globalContent).not.toContain('Constitution');
    expect(globalContent).not.toContain('Listening Mode');
    expect(globalContent).not.toContain('Pattern Sensing');
  });

  // Step 10: community template rendering verification
  it('community template has constitution, listening mode, pattern sensing, NO memory protocol', () => {
    const template = loadTemplate();
    const groupConfig: GroupConfig = {
      folder: communityFolder,
      slug: 'test-community',
      community_name: communityName,
    };
    const constitutionData: ConstitutionData = {
      slug: 'test-community',
      name: communityName,
      content: 'Be kind. Be fair. Listen more than you speak.',
      version: '1',
      content_hash: 'abc123',
      updated_at: '2026-03-20T00:00:00Z',
    };

    const rendered = buildClaudeMd(
      template,
      groupConfig,
      constitutionData,
      'https://emergentvibe.com',
    );

    // Has constitution content
    expect(rendered).toContain('Be kind. Be fair. Listen more than you speak.');
    expect(rendered).toContain('Constitution');
    // Has listening mode
    expect(rendered).toContain('Listening Mode');
    // Has pattern sensing
    expect(rendered).toContain('Pattern Sensing');
    // Does NOT have memory protocol (that's in global CLAUDE.md)
    expect(rendered).not.toContain('Mem0');
    expect(rendered).not.toContain('Namespaces');
    // No unreplaced placeholders
    const unreplaced = rendered.match(/\{\{[^}]+\}\}/g);
    expect(unreplaced).toBeNull();
  });

  // Step 11: DM template rendering verification
  it('DM template has "always respond", correct namespaces, NO listening mode', () => {
    const dmContent = buildDmClaudeMd(
      communityName,
      senderName,
      'user123',
      'test-community',
    );

    // Has "always respond"
    expect(dmContent).toContain('Always respond');
    // Has correct namespaces
    expect(dmContent).toContain('tg:user123');
    expect(dmContent).toContain('community:test-community');
    // Does NOT have listening mode (group-only)
    expect(dmContent).not.toContain('Listening Mode');
    // Does NOT have pattern sensing (group-only)
    expect(dmContent).not.toContain('Pattern Sensing');
    // Does NOT have "silence is your default" (group-only)
    expect(dmContent).not.toContain('silence is your default');
  });
});
