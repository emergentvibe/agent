import type { Bot, InlineKeyboard as IKType } from 'grammy';

import { ROTA_SHIFTS_TOPIC_ID, ROTA_GROUP_JID } from './config.js';
import { isCrewMember } from './crew.js';
import { loadFeatureConfig } from './feature-config.js';
import { logger } from './logger.js';
import {
  rotaGetByTelegramId,
  rotaGetByHandle,
  rotaBindTelegramId,
  rotaGetById,
  rotaGetByDate,
  rotaGetMeta,
  rotaRelease,
  rotaClaim,
  rotaLeaveEarly,
  type RotaAssignment,
} from './rota-db.js';

export interface RotaCommandOpts {
  registeredGroups: () => Record<string, import('./types.js').RegisteredGroup>;
  sendToShiftsTopic: (text: string, keyboard?: IKType) => Promise<void>;
  sendDm: (userId: string, text: string) => Promise<void>;
}

function resolveIdentity(
  telegramId: string,
  username?: string,
): RotaAssignment[] {
  let rows = rotaGetByTelegramId(telegramId);
  if (rows.length > 0) return rows;

  if (username) {
    const handle = username.startsWith('@') ? username : `@${username}`;
    rows = rotaGetByHandle(handle);
    if (rows.length > 0) {
      rotaBindTelegramId(handle, telegramId);
      logger.info({ handle, telegramId }, 'Rota: lazy-bound telegram ID');
    }
  }
  return rows;
}

function isRotaEnabled(
  groups: Record<string, import('./types.js').RegisteredGroup>,
): boolean {
  const mainGroup = Object.values(groups).find((g) => g.isMain);
  if (!mainGroup) return false;
  const config = loadFeatureConfig(mainGroup.folder);
  return config.commands.rota;
}

function formatDate(date: string): string {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function formatAssignment(a: RotaAssignment): string {
  return `${a.block_label} ${a.start}–${a.end}, ${formatDate(a.date)}`;
}

export function rotaCommandEntries(): Array<{
  command: string;
  description: string;
  local: true;
}> {
  return [
    { command: 'cover', description: 'Request cover for a shift', local: true },
    { command: 'shifts', description: "Today's kitchen schedule", local: true },
    { command: 'myrota', description: 'See your full rota', local: true },
    {
      command: 'leaveearly',
      description: 'Release all remaining shifts',
      local: true,
    },
    {
      command: 'hands',
      description: 'Kitchen needs help! (crew only)',
      local: true,
    },
    {
      command: 'h',
      description: 'Kitchen needs help! (crew only)',
      local: true,
    },
  ];
}

export function registerRotaCommands(
  bot: Bot,
  opts: RotaCommandOpts,
  InlineKeyboard: typeof IKType,
): void {
  // /cover — DM only, shows sender's shifts as buttons
  bot.command('cover', async (ctx) => {
    if (!isRotaEnabled(opts.registeredGroups())) return;
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Please use /cover in a DM with me.');
      return;
    }

    const meta = rotaGetMeta();
    if (!meta) {
      await ctx.reply('No rota loaded yet.');
      return;
    }

    const telegramId = ctx.from?.id?.toString() || '';
    const username = ctx.from?.username;
    const myShifts = resolveIdentity(telegramId, username);
    const now = new Date().toISOString().slice(0, 10);
    const future = myShifts.filter(
      (a) => a.state === 'assigned' && a.date >= now,
    );

    if (future.length === 0) {
      await ctx.reply("You don't have any upcoming shifts to cover.");
      return;
    }

    const kb = new InlineKeyboard();
    for (const a of future) {
      kb.text(formatAssignment(a), `rota:cover:${a.id}`).row();
    }

    await ctx.reply('Which shift do you need covered?', { reply_markup: kb });
  });

  // /shifts — today's schedule
  bot.command('shifts', async (ctx) => {
    if (!isRotaEnabled(opts.registeredGroups())) return;

    const meta = rotaGetMeta();
    if (!meta) {
      await ctx.reply('No rota loaded yet.');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const assignments = rotaGetByDate(today);

    if (assignments.length === 0) {
      await ctx.reply('No shifts scheduled for today.');
      return;
    }

    const blockGroups = new Map<string, RotaAssignment[]>();
    for (const a of assignments) {
      const key = `${a.start}–${a.end} ${a.block_label}`;
      if (!blockGroups.has(key)) blockGroups.set(key, []);
      blockGroups.get(key)!.push(a);
    }

    const lines: string[] = [`*Shifts for ${formatDate(today)}*\n`];
    for (const [block, slots] of blockGroups) {
      lines.push(`*${block}*`);
      for (const s of slots) {
        if (s.state === 'open') {
          lines.push(
            `  ${s.original_name || '???'} ${s.original_telegram || ''} — cover requested`,
          );
        } else if (s.state === 'covered') {
          lines.push(
            `  ${s.original_name || '???'} → *${s.current_name}* ${s.current_telegram || ''} covering`,
          );
        } else {
          lines.push(
            `  ${s.current_name || s.original_name || '???'} ${s.original_telegram || ''}`,
          );
        }
      }
      lines.push('');
    }

    await ctx.reply(lines.join('\n').trim(), { parse_mode: 'Markdown' });
  });

  // /myrota — DM only, full week
  bot.command('myrota', async (ctx) => {
    if (!isRotaEnabled(opts.registeredGroups())) return;
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Please use /myrota in a DM with me.');
      return;
    }

    const meta = rotaGetMeta();
    if (!meta) {
      await ctx.reply('No rota loaded yet.');
      return;
    }

    const telegramId = ctx.from?.id?.toString() || '';
    const username = ctx.from?.username;
    const myShifts = resolveIdentity(telegramId, username);

    if (myShifts.length === 0) {
      await ctx.reply("You're not on the rota.");
      return;
    }

    const lines: string[] = ['*Your shifts*\n'];
    let totalWeighted = 0;

    for (const a of myShifts) {
      let status = '';
      if (a.state === 'open') status = ' — cover requested';
      else if (a.state === 'covered')
        status = ` — covered by ${a.current_name || '???'}`;
      lines.push(`${formatDate(a.date)}: ${formatAssignment(a)}${status}`);
      totalWeighted += a.weight;
    }

    lines.push(`\nWeighted hours: ${totalWeighted.toFixed(1)}`);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /leaveearly — DM only, release all future shifts
  bot.command('leaveearly', async (ctx) => {
    if (!isRotaEnabled(opts.registeredGroups())) return;
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Please use /leaveearly in a DM with me.');
      return;
    }

    const telegramId = ctx.from?.id?.toString() || '';
    const username = ctx.from?.username;
    resolveIdentity(telegramId, username);

    const count = rotaLeaveEarly(telegramId);
    if (count === 0) {
      await ctx.reply('No upcoming shifts to release.');
      return;
    }

    await ctx.reply(
      `Released ${count} shift${count > 1 ? 's' : ''}. Cover requests have been posted.`,
    );

    // Post each to Shifts topic
    const openShifts = rotaGetByTelegramId(telegramId).filter(
      (a) => a.state === 'open',
    );
    // After leave_early, the shifts won't match by telegram_id anymore (current_person is null)
    // So we need to look them up differently — use the log or re-query by handle
    // Actually rotaLeaveEarly nulls current_person but keeps original_telegram_id
    // Re-query: they have state='open' and original_telegram_id=telegramId
    const { _getDb } = await import('./db.js');
    const db = _getDb();
    const released = db
      .prepare(
        `SELECT * FROM rota_assignments WHERE original_telegram_id = ? AND state = 'open' ORDER BY date, start`,
      )
      .all(telegramId) as RotaAssignment[];

    for (const a of released) {
      const kb = new InlineKeyboard();
      kb.text('Claim this shift', `rota:claim:${a.id}`);
      await opts.sendToShiftsTopic(
        `Cover needed: ${formatAssignment(a)} (${a.original_name || '???'})`,
        kb,
      );
    }

    // Notify crew
    const mainGroup = Object.values(opts.registeredGroups()).find(
      (g) => g.isMain,
    );
    if (mainGroup) {
      const name = ctx.from?.first_name || ctx.from?.username || 'Someone';
      logger.info(
        { telegramId, count },
        `${name} is leaving early, ${count} shifts released`,
      );
    }
  });

  // /hands or /h — crew only, broadcast to Shifts topic
  for (const cmd of ['hands', 'h'] as const) {
    bot.command(cmd, async (ctx) => {
      if (!isRotaEnabled(opts.registeredGroups())) return;

      const sender = ctx.from?.id?.toString() || '';
      const mainGroup = Object.values(opts.registeredGroups()).find(
        (g) => g.isMain,
      );
      if (!mainGroup || !isCrewMember(mainGroup.folder, sender)) {
        await ctx.reply('This command is for crew members only.');
        return;
      }

      const kb = new InlineKeyboard();
      kb.text("I'm coming!", `rota:coming:${Date.now()}`);
      await opts.sendToShiftsTopic('Kitchen needs hands now!', kb);
      await ctx.reply('Posted to the Shifts topic.');
    });
  }

  // --- Callback queries ---

  // Cover request button tap (from /cover DM)
  bot.callbackQuery(/^rota:cover:(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^rota:cover:(.+)$/);
    if (!match) return;
    const assignmentId = match[1];
    const telegramId = ctx.from.id.toString();

    const result = rotaRelease(assignmentId, telegramId);
    if (!result.ok) {
      const msg =
        result.reason === 'one_open'
          ? 'You already have a cover request out. Once someone claims it, you can request another.'
          : 'Could not release this shift. It may already be released or covered.';
      await ctx.answerCallbackQuery({ text: msg, show_alert: true });
      return;
    }

    const assignment = rotaGetById(assignmentId);
    if (!assignment) return;

    await ctx.answerCallbackQuery({ text: 'Cover request posted!' });
    try {
      await ctx.editMessageText(
        `Cover request posted for ${formatAssignment(assignment)}.\nYou're still on this shift until someone claims it.`,
      );
    } catch {
      // Message may be too old
    }

    // Post to Shifts topic
    const kb = new InlineKeyboard();
    kb.text('Claim this shift', `rota:claim:${assignmentId}`);
    await opts.sendToShiftsTopic(
      `Cover needed: ${formatAssignment(assignment)} (${assignment.original_name || '???'})`,
      kb,
    );
  });

  // Claim button tap (from Shifts topic)
  bot.callbackQuery(/^rota:claim:(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^rota:claim:(.+)$/);
    if (!match) return;
    const assignmentId = match[1];
    const claimerId = ctx.from.id.toString();
    const claimerName = ctx.from.first_name || ctx.from.username || 'Someone';
    const claimerHandle = ctx.from.username ? `@${ctx.from.username}` : null;

    const result = rotaClaim(
      assignmentId,
      claimerId,
      claimerName,
      claimerHandle,
    );
    if (!result.ok) {
      const msg =
        result.reason === 'overlap'
          ? 'You already have a shift at that time!'
          : 'Someone already picked up this shift!';
      await ctx.answerCallbackQuery({ text: msg, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'You got it!' });

    const assignment = rotaGetById(assignmentId);
    if (!assignment) return;

    try {
      await ctx.editMessageText(
        `${formatAssignment(assignment)} — claimed by *${claimerName}* ${claimerHandle || ''}`,
        { parse_mode: 'Markdown' },
      );
    } catch {
      // Message may be too old
    }

    // DM the original person
    if (assignment.original_telegram_id) {
      await opts.sendDm(
        assignment.original_telegram_id,
        `Your ${assignment.block_label} shift on ${formatDate(assignment.date)} has been covered by ${claimerName}.`,
      );
    }
  });

  // /hands response — toast only
  bot.callbackQuery(/^rota:coming:/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: 'Thanks! Head to the kitchen.',
    });
  });
}
