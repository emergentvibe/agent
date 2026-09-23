import type { Bot, InlineKeyboard as IKType } from 'grammy';
import type Database from 'better-sqlite3';

import { _getDb } from './db.js';
import { logger } from './logger.js';
import {
  attendeeFuzzySearch,
  attendeeLookupByTelegramId,
  type AttendeeRecord,
} from './attendee-db.js';
import { loadFeatureConfig } from './feature-config.js';
import type { RegisteredGroup } from './types.js';

export function createCrushSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS crushes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crusher_telegram_id TEXT NOT NULL,
      crusher_name TEXT NOT NULL,
      crushee_attendee_id INTEGER NOT NULL,
      crushee_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(crusher_telegram_id, crushee_attendee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crushes_crusher ON crushes(crusher_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_crushes_crushee ON crushes(crushee_attendee_id);
  `);
}

export interface CrushRecord {
  id: number;
  crusher_telegram_id: string;
  crusher_name: string;
  crushee_attendee_id: number;
  crushee_name: string;
  created_at: string;
}

const crushPending = new Map<string, boolean>();

export function setCrushPending(chatJid: string): void {
  crushPending.set(chatJid, true);
}

export function hasCrushPending(chatJid: string): boolean {
  return crushPending.has(chatJid);
}

export function clearCrushPending(chatJid: string): void {
  crushPending.delete(chatJid);
}

export function crushStore(
  crusherTelegramId: string,
  crusherName: string,
  crusheeAttendeeId: number,
  crusheeName: string,
): { ok: boolean; duplicate: boolean } {
  const db = _getDb();
  try {
    db.prepare(
      `INSERT INTO crushes (crusher_telegram_id, crusher_name, crushee_attendee_id, crushee_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      crusherTelegramId,
      crusherName,
      crusheeAttendeeId,
      crusheeName,
      new Date().toISOString(),
    );
    return { ok: true, duplicate: false };
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { ok: false, duplicate: true };
    }
    throw err;
  }
}

export function crushCheckMutual(
  crusherTelegramId: string,
  crusheeAttendeeId: number,
): { mutual: boolean; otherTelegramId?: string } {
  const db = _getDb();
  const crushee = db
    .prepare('SELECT telegram_id FROM attendees WHERE id = ?')
    .get(crusheeAttendeeId) as { telegram_id: string | null } | undefined;

  if (!crushee?.telegram_id) return { mutual: false };

  const crusherAttendee = attendeeLookupByTelegramId(crusherTelegramId);
  if (!crusherAttendee) return { mutual: false };

  const reverse = db
    .prepare(
      'SELECT id FROM crushes WHERE crusher_telegram_id = ? AND crushee_attendee_id = ?',
    )
    .get(crushee.telegram_id, crusherAttendee.id) as
    | { id: number }
    | undefined;

  return reverse
    ? { mutual: true, otherTelegramId: crushee.telegram_id }
    : { mutual: false };
}

export function crushGetLeaderboard(): {
  totalCrushes: number;
  mutualMatches: number;
  leaderboard: Array<{ name: string; count: number }>;
} {
  const db = _getDb();

  const totalCrushes = (
    db.prepare('SELECT COUNT(*) as c FROM crushes').get() as { c: number }
  ).c;

  const leaderboard = db
    .prepare(
      `SELECT crushee_name as name, COUNT(*) as count
       FROM crushes GROUP BY crushee_attendee_id
       ORDER BY count DESC`,
    )
    .all() as Array<{ name: string; count: number }>;

  const mutualMatches = db
    .prepare(
      `SELECT COUNT(*) as c FROM crushes c1
       JOIN crushes c2 ON c1.crushee_attendee_id = (
         SELECT id FROM attendees WHERE telegram_id = c2.crusher_telegram_id
       ) AND c2.crushee_attendee_id = (
         SELECT id FROM attendees WHERE telegram_id = c1.crusher_telegram_id
       ) AND c1.id < c2.id`,
    )
    .get() as { c: number };

  return {
    totalCrushes,
    mutualMatches: mutualMatches.c,
    leaderboard,
  };
}

export interface CrushCommandOpts {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendDm: (userId: string, text: string) => Promise<void>;
}

function isSocialEnabled(
  groups: Record<string, RegisteredGroup>,
): boolean {
  const mainGroup = Object.values(groups).find((g) => g.isMain);
  if (!mainGroup) return false;
  return loadFeatureConfig(mainGroup.folder).commands.social;
}

export function crushCommandEntries(): Array<{
  command: string;
  description: string;
  local: boolean;
  visible?: boolean;
  featureGate?: 'social';
}> {
  return [
    {
      command: 'crush',
      description: 'Anonymous crush matching',
      local: true,
      featureGate: 'social',
    },
  ];
}

export function registerCrushCommands(
  bot: Bot,
  opts: CrushCommandOpts,
  InlineKeyboard: typeof IKType,
): void {
  bot.command('crush', async (ctx) => {
    if (!isSocialEnabled(opts.registeredGroups())) return;

    if (ctx.chat.type !== 'private') {
      await ctx.reply(
        "This one's a DM thing — send /crush to me privately 😏",
      );
      return;
    }

    const chatJid = `tg:${ctx.chat.id}`;
    setCrushPending(chatJid);
    await ctx.reply("Who's caught your eye? Send me their name.");
  });

  bot.callbackQuery(/^crush:confirm:(\d+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^crush:confirm:(\d+)$/);
    if (!match) return;
    await handleCrushConfirm(ctx, parseInt(match[1], 10), opts, InlineKeyboard);
  });

  bot.callbackQuery(/^crush:pick:(\d+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^crush:pick:(\d+)$/);
    if (!match) return;
    await handleCrushConfirm(ctx, parseInt(match[1], 10), opts, InlineKeyboard);
  });

  bot.callbackQuery('crush:cancel', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'No worries!' });
    try {
      await ctx.editMessageText('No worries. /crush again whenever.');
    } catch {}
  });
}

async function handleCrushConfirm(
  ctx: any,
  attendeeId: number,
  opts: CrushCommandOpts,
  _InlineKeyboard: typeof IKType,
): Promise<void> {
  const crusherTelegramId = ctx.from.id.toString();
  const crusherName =
    ctx.from.first_name || ctx.from.username || crusherTelegramId;

  const selfAttendee = attendeeLookupByTelegramId(crusherTelegramId);
  if (selfAttendee && selfAttendee.id === attendeeId) {
    await ctx.answerCallbackQuery({ text: "Can't crush on yourself!" });
    try {
      await ctx.editMessageText(
        "You're great, but that's not how this works. Try /crush again with someone else.",
      );
    } catch {}
    return;
  }

  const db = _getDb();
  const crushee = db.prepare('SELECT name FROM attendees WHERE id = ?').get(attendeeId) as
    | { name: string }
    | undefined;

  if (!crushee) {
    await ctx.answerCallbackQuery({
      text: 'Person not found',
      show_alert: true,
    });
    return;
  }

  const result = crushStore(
    crusherTelegramId,
    crusherName,
    attendeeId,
    crushee.name,
  );

  if (result.duplicate) {
    await ctx.answerCallbackQuery({ text: 'Already crushing!' });
    try {
      await ctx.editMessageText(
        `You've already got a crush on ${crushee.name}!`,
      );
    } catch {}
    return;
  }

  const mutual = crushCheckMutual(crusherTelegramId, attendeeId);

  if (mutual.mutual && mutual.otherTelegramId) {
    await ctx.answerCallbackQuery({ text: "It's mutual! 💫" });
    try {
      await ctx.editMessageText(
        `It's mutual! You and *${crushee.name}* both crushed on each other. 💫`,
        { parse_mode: 'Markdown' },
      );
    } catch {}

    try {
      await opts.sendDm(
        mutual.otherTelegramId,
        `It's mutual! You and *${crusherName}* both crushed on each other. 💫`,
      );
    } catch (err) {
      logger.warn({ err, userId: mutual.otherTelegramId }, 'Failed to DM mutual crush');
    }
  } else {
    await ctx.answerCallbackQuery({ text: 'Got it!' });
    try {
      await ctx.editMessageText("Got it — I'll keep it between us.");
    } catch {}
  }

  logger.info(
    {
      crusher: crusherTelegramId,
      crushee: crushee.name,
      mutual: mutual.mutual,
    },
    'Crush stored',
  );
}

export async function handleCrushNameInput(
  ctx: any,
  text: string,
  opts: CrushCommandOpts,
  InlineKeyboard: typeof IKType,
): Promise<void> {
  const crusherTelegramId = ctx.from?.id?.toString() || '';

  const selfAttendee = attendeeLookupByTelegramId(crusherTelegramId);

  const matches = attendeeFuzzySearch(text);
  const filtered = matches.filter(
    (m) => !selfAttendee || m.id !== selfAttendee.id,
  );

  if (filtered.length === 0 && matches.length > 0 && matches[0].id === selfAttendee?.id) {
    await ctx.reply(
      "You're great, but that's not how this works. Try /crush again with someone else.",
    );
    return;
  }

  if (filtered.length === 0) {
    await ctx.reply(
      "I don't know anyone by that name. Try /crush again?",
    );
    return;
  }

  if (filtered.length === 1) {
    const kb = new InlineKeyboard()
      .text('Yes', `crush:confirm:${filtered[0].id}`)
      .text('No', 'crush:cancel');
    await ctx.reply(`Did you mean *${filtered[0].name}*?`, {
      reply_markup: kb,
      parse_mode: 'Markdown',
    });
    return;
  }

  const kb = new InlineKeyboard();
  for (const m of filtered) {
    kb.text(m.name, `crush:pick:${m.id}`).row();
  }
  kb.text('None of these', 'crush:cancel').row();
  await ctx.reply('Which one?', { reply_markup: kb });
}
