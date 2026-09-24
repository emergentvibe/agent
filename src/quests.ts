import fs from 'fs';
import path from 'path';
import type { Bot } from 'grammy';
import type Database from 'better-sqlite3';

import { _getDb } from './db.js';
import { logger } from './logger.js';
import { loadFeatureConfig } from './feature-config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import type { RegisteredGroup } from './types.js';

export function createQuestSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS quest_optins (
      telegram_id TEXT PRIMARY KEY,
      attendee_name TEXT NOT NULL,
      opted_in_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      quest_text TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quest_log_user ON quest_log(telegram_id);
  `);
}

export function questOptIn(
  telegramId: string,
  name: string,
): { alreadyIn: boolean } {
  const db = _getDb();
  const existing = db
    .prepare('SELECT telegram_id FROM quest_optins WHERE telegram_id = ?')
    .get(telegramId);
  if (existing) return { alreadyIn: true };
  db.prepare(
    'INSERT INTO quest_optins (telegram_id, attendee_name, opted_in_at) VALUES (?, ?, ?)',
  ).run(telegramId, name, new Date().toISOString());
  return { alreadyIn: false };
}

export function questOptOut(telegramId: string): { wasIn: boolean } {
  const db = _getDb();
  const result = db
    .prepare('DELETE FROM quest_optins WHERE telegram_id = ?')
    .run(telegramId);
  return { wasIn: result.changes > 0 };
}

export function questIsOptedIn(telegramId: string): boolean {
  const db = _getDb();
  const row = db
    .prepare('SELECT telegram_id FROM quest_optins WHERE telegram_id = ?')
    .get(telegramId);
  return !!row;
}

export function questGetOptedIn(): Array<{
  telegram_id: string;
  attendee_name: string;
}> {
  const db = _getDb();
  return db
    .prepare('SELECT telegram_id, attendee_name FROM quest_optins')
    .all() as Array<{
    telegram_id: string;
    attendee_name: string;
  }>;
}

export function questGetSentQuests(telegramId: string): string[] {
  const db = _getDb();
  const rows = db
    .prepare('SELECT quest_text FROM quest_log WHERE telegram_id = ?')
    .all(telegramId) as Array<{ quest_text: string }>;
  return rows.map((r) => r.quest_text);
}

export function questLogDelivery(telegramId: string, questText: string): void {
  const db = _getDb();
  db.prepare(
    'INSERT INTO quest_log (telegram_id, quest_text, sent_at) VALUES (?, ?, ?)',
  ).run(telegramId, questText, new Date().toISOString());
}

export function questGetLastToday(telegramId: string): string | null {
  const db = _getDb();
  const today = new Date().toISOString().split('T')[0];
  const row = db
    .prepare(
      `SELECT quest_text FROM quest_log
       WHERE telegram_id = ? AND sent_at >= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(telegramId, today) as { quest_text: string } | undefined;
  return row?.quest_text ?? null;
}

const DEFAULT_QUESTS: string[] = [
  'Act like a cat for 10 minutes',
  "Give a genuine compliment to 3 people you haven't spoken to yet",
  'Find something beautiful and show it to a stranger',
  'Sit in complete silence for 5 minutes in a public space',
  "Trade an item you're carrying with someone else's item",
  "Learn someone's name you don't know yet and tell them something about yourself",
  'Teach someone a skill in under 5 minutes',
  "Learn 5 words in a language you don't speak from someone here",
  'Write a haiku about what you see right now and read it to someone',
  "Help with someone else's project for 15 minutes",
  'Start a conversation with the next person you make eye contact with',
  'Find the best view around here and sit with it for 5 minutes',
  'Do something kind for someone without them knowing',
  'Make something with your hands and give it to someone',
  'Ask someone what their favourite memory from this week is',
  'Propose a spontaneous activity and see who joins',
  "Eat a meal with someone you haven't sat with yet",
  'Go for a walk with no destination for 15 minutes',
  'Find a natural object and leave it somewhere as a gift for the next person',
  "Tell someone a true story you've never told anyone here",
];

export function loadQuests(groupFolder: string): string[] {
  const questsPath = path.join(
    resolveGroupFolderPath(groupFolder),
    'quests.json',
  );
  if (!fs.existsSync(questsPath)) return DEFAULT_QUESTS;
  try {
    const data = JSON.parse(fs.readFileSync(questsPath, 'utf-8'));
    return Array.isArray(data) && data.length > 0 ? data : DEFAULT_QUESTS;
  } catch {
    return DEFAULT_QUESTS;
  }
}

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export interface QuestLoopOpts {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendDm: (userId: string, text: string) => Promise<void>;
}

export async function deliverQuests(opts: QuestLoopOpts): Promise<number> {
  const groups = opts.registeredGroups();
  const mainGroup = Object.values(groups).find((g) => g.isMain);
  if (!mainGroup) return 0;

  const features = loadFeatureConfig(mainGroup.folder);
  if (!features.commands.social) return 0;

  const allQuests = loadQuests(mainGroup.folder);
  if (allQuests.length === 0) return 0;

  const optedIn = questGetOptedIn();
  if (optedIn.length === 0) return 0;

  const subsetSize = Math.max(1, Math.ceil(optedIn.length * 0.4));
  const selected = pickRandom(optedIn, subsetSize);

  let delivered = 0;
  for (const user of selected) {
    try {
      const sent = questGetSentQuests(user.telegram_id);
      const sentSet = new Set(sent);
      const unsent = allQuests.filter((q) => !sentSet.has(q));

      if (unsent.length === 0) {
        await opts.sendDm(
          user.telegram_id,
          "You've completed all quests! Legend status. 🏆",
        );
        questOptOut(user.telegram_id);
        continue;
      }

      const quest = unsent[Math.floor(Math.random() * unsent.length)];
      await opts.sendDm(user.telegram_id, `🎯 *Your quest:* ${quest}`);
      questLogDelivery(user.telegram_id, quest);
      delivered++;
    } catch (err) {
      logger.warn({ err, userId: user.telegram_id }, 'Failed to deliver quest');
    }
  }

  logger.info(
    { delivered, totalOptedIn: optedIn.length, subsetSize },
    'Quest delivery round complete',
  );
  return delivered;
}

const MIN_INTERVAL = 1 * 60 * 60 * 1000; // 1 hour
const MAX_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
const ACTIVE_START = 13;
const ACTIVE_END = 21;

function randomInterval(): number {
  return MIN_INTERVAL + Math.random() * (MAX_INTERVAL - MIN_INTERVAL);
}

export function startQuestLoop(opts: QuestLoopOpts): void {
  logger.info(
    'Quest delivery loop started (random 1-4hr intervals, 13:00-21:00)',
  );

  const scheduleNext = () => {
    const delay = randomInterval();
    setTimeout(async () => {
      const hour = new Date().getHours();
      if (hour >= ACTIVE_START && hour < ACTIVE_END) {
        try {
          await deliverQuests(opts);
        } catch (err) {
          logger.error({ err }, 'Quest delivery error');
        }
      } else {
        logger.debug('Quest delivery skipped (outside 13:00-21:00)');
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

function isSocialEnabled(groups: Record<string, RegisteredGroup>): boolean {
  const mainGroup = Object.values(groups).find((g) => g.isMain);
  if (!mainGroup) return false;
  return loadFeatureConfig(mainGroup.folder).commands.social;
}

export function questCommandEntries(): Array<{
  command: string;
  description: string;
  local: boolean;
  visible?: boolean;
  featureGate?: 'social';
}> {
  return [
    {
      command: 'quests',
      description: 'Sign up for random quests',
      local: true,
      featureGate: 'social',
    },
    {
      command: 'current_quest',
      description: 'See your current quest',
      local: true,
      visible: false,
      featureGate: 'social',
    },
  ];
}

export interface QuestCommandOpts {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export function registerQuestCommands(bot: Bot, opts: QuestCommandOpts): void {
  bot.command('quests', async (ctx) => {
    if (!isSocialEnabled(opts.registeredGroups())) return;

    if (ctx.chat.type !== 'private') {
      await ctx.reply('Send /quests to me in a DM to sign up!');
      return;
    }

    const telegramId = ctx.from?.id?.toString() || '';
    const name = ctx.from?.first_name || ctx.from?.username || telegramId;

    if (questIsOptedIn(telegramId)) {
      questOptOut(telegramId);
      await ctx.reply('Opted out of quests. You can /quests again to rejoin.');
    } else {
      questOptIn(telegramId, name);
      await ctx.reply(
        "You're in! Random quests will appear in your DMs throughout the day. 🎯",
      );
    }
  });

  bot.command('current_quest', async (ctx) => {
    if (!isSocialEnabled(opts.registeredGroups())) return;

    if (ctx.chat.type !== 'private') {
      await ctx.reply('Send /current_quest to me in a DM!');
      return;
    }

    const telegramId = ctx.from?.id?.toString() || '';

    if (!questIsOptedIn(telegramId)) {
      await ctx.reply('Run /quests to receive a quest.');
      return;
    }

    const lastQuest = questGetLastToday(telegramId);
    if (lastQuest) {
      await ctx.reply(`🎯 *Your quest:* ${lastQuest}`, {
        parse_mode: 'Markdown',
      });
    } else {
      await ctx.reply("No quest yet today — one's coming!");
    }
  });
}
