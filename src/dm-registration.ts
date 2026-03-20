/**
 * DM Auto-Registration
 * When a DM arrives from a user who's in a registered community group,
 * auto-register the DM with correct folder, mounts, and CLAUDE.md.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const DM_TEMPLATE_PATH = path.resolve(
  import.meta.dirname ?? '.',
  '../governance/templates/dm-template.md',
);

/**
 * Sanitize a sender identifier into a valid folder name segment.
 * Keeps alphanumeric and hyphens, max 64 chars total.
 */
export function sanitizeForFolder(senderId: string): string {
  if (!senderId || typeof senderId !== 'string') {
    throw new Error('Invalid sender ID');
  }
  const sanitized = senderId
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  if (!sanitized) {
    throw new Error(`Sender ID "${senderId}" produces empty folder name`);
  }
  return sanitized;
}

/**
 * Build a DM CLAUDE.md from the DM template.
 */
export function buildDmClaudeMd(
  communityName: string,
  userName: string,
  userId: string,
  slug: string,
  adminId?: string,
): string {
  const template = fs.readFileSync(DM_TEMPLATE_PATH, 'utf-8');
  return template
    .replace(/\{\{community_name\}\}/g, communityName)
    .replace(/\{\{user_name\}\}/g, userName)
    .replace(/\{\{user_id\}\}/g, userId)
    .replace(/\{\{slug\}\}/g, slug)
    .replace(/\{\{admin_id\}\}/g, adminId || 'unknown');
}

/**
 * Write a DM CLAUDE.md to the DM group folder.
 */
export function writeDmClaudeMd(
  dmFolder: string,
  communityName: string,
  userName: string,
  userId: string,
  slug: string,
  adminId?: string,
): void {
  const dmDir = resolveGroupFolderPath(dmFolder);
  fs.mkdirSync(dmDir, { recursive: true });

  const content = buildDmClaudeMd(communityName, userName, userId, slug, adminId);
  fs.writeFileSync(path.join(dmDir, 'CLAUDE.md'), content, 'utf-8');

  logger.info({ dmFolder, userName }, 'Wrote DM CLAUDE.md');
}

export interface CommunityMatch {
  jid: string;
  group: RegisteredGroup;
  slug: string;
}

/**
 * Find which community group a sender belongs to.
 * Checks registered groups to find ones where this sender has sent messages.
 *
 * @param senderJid - The sender's JID (e.g., tg:12345)
 * @param registeredGroups - Currently registered groups
 * @param findSenderInGroup - Function that checks if sender has messages in a group's chat
 */
export function findCommunityForUser(
  senderJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
  findSenderInGroup: (chatJid: string, senderJid: string) => boolean,
): CommunityMatch | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    // Skip DM folders and main group
    if (group.isMain) continue;
    if (group.folder.includes('-dm-')) continue;

    if (findSenderInGroup(jid, senderJid)) {
      // Extract slug from the community CLAUDE.md if it exists
      const claudeMdPath = path.join(
        resolveGroupFolderPath(group.folder),
        'CLAUDE.md',
      );
      let slug = group.folder; // fallback
      if (fs.existsSync(claudeMdPath)) {
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        const slugMatch = content.match(/constitution_slug:\s*"([^"]+)"/);
        if (slugMatch) slug = slugMatch[1];
      }

      return { jid, group, slug };
    }
  }
  return null;
}
