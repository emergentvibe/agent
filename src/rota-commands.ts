import type { Bot, InlineKeyboard as IKType } from 'grammy';

import {
  ROTA_SHIFTS_TOPIC_ID,
  ROTA_GROUP_JID,
  ADMIN_TELEGRAM_ID,
} from './config.js';
import { isCrewMember } from './crew.js';
import { loadFeatureConfig } from './feature-config.js';
import { logger } from './logger.js';
import {
  rotaGetByTelegramId,
  rotaGetByHandle,
  rotaGetCoveredByPerson,
  rotaBindTelegramId,
  rotaGetById,
  rotaGetByDate,
  rotaGetOpenSlots,
  rotaGetMeta,
  rotaRelease,
  rotaRerelease,
  rotaClaim,
  rotaLeaveEarly,
  rotaGetBoardMessageId,
  rotaSetBoardMessageId,
  rotaClearBoardMessageId,
  type RotaAssignment,
} from './rota-db.js';

export interface RotaCommandOpts {
  registeredGroups: () => Record<string, import('./types.js').RegisteredGroup>;
  sendToShiftsTopic: (
    text: string,
    keyboard?: IKType,
  ) => Promise<number | undefined>;
  editShiftsTopicMessage: (
    messageId: number,
    text: string,
    keyboard?: IKType,
  ) => Promise<void>;
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

// --- Shifts Board ---

function buildBoardContent(InlineKeyboard: typeof IKType): {
  text: string;
  keyboard: IKType | undefined;
  count: number;
} {
  const openSlots = rotaGetOpenSlots();
  const now = new Date().toISOString().slice(0, 10);
  const future = openSlots.filter((a) => a.date >= now);

  if (future.length === 0) {
    return { text: 'All shifts are covered!', keyboard: undefined, count: 0 };
  }

  const kb = new InlineKeyboard();
  for (const a of future) {
    kb.text(
      `${formatAssignment(a)} (${a.original_name || '???'})`,
      `rota:claim:${a.id}`,
    ).row();
  }

  return {
    text: `${future.length} open shift${future.length > 1 ? 's' : ''} — tap to claim:`,
    keyboard: kb,
    count: future.length,
  };
}

export async function postShiftsBoard(
  opts: RotaCommandOpts,
  InlineKeyboard: typeof IKType,
): Promise<void> {
  const { text, keyboard, count } = buildBoardContent(InlineKeyboard);

  const oldBoardId = rotaGetBoardMessageId();
  if (oldBoardId) {
    try {
      await opts.editShiftsTopicMessage(
        oldBoardId,
        'See latest open shifts below ↓',
      );
    } catch {
      // Old message may be too old to edit
    }
  }

  if (count === 0) {
    rotaClearBoardMessageId();
    return;
  }

  const msgId = await opts.sendToShiftsTopic(text, keyboard);
  if (msgId) {
    rotaSetBoardMessageId(msgId);
  }
}

// --- Command entries ---

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
      command: 'openshifts',
      description: 'See open shifts you can claim',
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

    // Also show shifts this person is covering for someone else
    const covering = rotaGetCoveredByPerson(telegramId).filter(
      (a) => a.date >= now,
    );

    if (future.length === 0 && covering.length === 0) {
      await ctx.reply("You don't have any upcoming shifts to cover.");
      return;
    }

    const kb = new InlineKeyboard();
    for (const a of future) {
      kb.text(formatAssignment(a), `rota:cover:${a.id}`).row();
    }
    for (const a of covering) {
      kb.text(
        `Give back: ${formatAssignment(a)}`,
        `rota:rerelease:${a.id}`,
      ).row();
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

  // /leaveearly — admin only, DM only, release all future shifts for a person
  bot.command('leaveearly', async (ctx) => {
    if (!isRotaEnabled(opts.registeredGroups())) return;
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Please use /leaveearly in a DM with me.');
      return;
    }

    const telegramId = ctx.from?.id?.toString() || '';
    const adminIds = (ADMIN_TELEGRAM_ID || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!adminIds.includes(telegramId)) {
      await ctx.reply(
        "This command is for admins only. If you need to release a shift, use /cover.",
      );
      return;
    }
    const username = ctx.from?.username;
    resolveIdentity(telegramId, username);

    const releasedIds = rotaLeaveEarly(telegramId);
    if (releasedIds.length === 0) {
      await ctx.reply('No upcoming shifts to release.');
      return;
    }

    await ctx.reply(
      `Released ${releasedIds.length} shift${releasedIds.length > 1 ? 's' : ''}. Cover requests have been posted.`,
    );

    await postShiftsBoard(opts, InlineKeyboard);

    // Notify crew
    const mainGroup = Object.values(opts.registeredGroups()).find(
      (g) => g.isMain,
    );
    if (mainGroup) {
      const name = ctx.from?.first_name || ctx.from?.username || 'Someone';
      logger.info(
        { telegramId, count: releasedIds.length },
        `${name} is leaving early, ${releasedIds.length} shifts released`,
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

    await postShiftsBoard(opts, InlineKeyboard);
  });

  // Claim button tap (from Shifts Board in topic)
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

    // Update the board in place — rebuild with remaining open shifts
    const boardMsgId = rotaGetBoardMessageId();
    const tappedMsgId = ctx.callbackQuery.message?.message_id;
    const { text, keyboard, count } = buildBoardContent(InlineKeyboard);

    if (tappedMsgId === boardMsgId) {
      try {
        if (count > 0) {
          await ctx.editMessageText(text, { reply_markup: keyboard });
        } else {
          await ctx.editMessageText('All shifts are covered!');
        }
      } catch {
        // Message may be too old
      }
    } else {
      // Stale button (old board we couldn't deactivate) — update both
      try {
        await ctx.editMessageText(
          'Claimed! See latest message for open shifts.',
        );
      } catch {
        /* ignore */
      }
      if (boardMsgId) {
        try {
          if (count > 0) {
            await opts.editShiftsTopicMessage(boardMsgId, text, keyboard);
          } else {
            await opts.editShiftsTopicMessage(
              boardMsgId,
              'All shifts are covered!',
            );
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (count === 0) rotaClearBoardMessageId();

    // DM the original person
    if (assignment.original_telegram_id) {
      await opts.sendDm(
        assignment.original_telegram_id,
        `Your ${assignment.block_label} shift on ${formatDate(assignment.date)} has been covered by ${claimerName}. If you get the chance, covering someone else's shift is a nice way to pass it on.`,
      );
    }
  });

  // Re-release: claimer gives back a covered shift
  bot.callbackQuery(/^rota:rerelease:(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^rota:rerelease:(.+)$/);
    if (!match) return;
    const assignmentId = match[1];
    const telegramId = ctx.from.id.toString();

    const result = rotaRerelease(assignmentId, telegramId);
    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text: 'Could not release this shift.',
        show_alert: true,
      });
      return;
    }

    const assignment = rotaGetById(assignmentId);
    if (!assignment) return;

    await ctx.answerCallbackQuery({
      text: 'Shift released — cover request posted.',
    });
    try {
      await ctx.editMessageText(
        `Released: ${formatAssignment(assignment)}. Cover request posted.`,
      );
    } catch {
      // Message may be too old
    }

    await postShiftsBoard(opts, InlineKeyboard);

    // Notify the original person their shift is uncovered again
    if (assignment.original_telegram_id) {
      const releaserName =
        ctx.from.first_name || ctx.from.username || 'Someone';
      await opts.sendDm(
        assignment.original_telegram_id,
        `Heads up — ${releaserName} can no longer cover your ${assignment.block_label} shift on ${formatDate(assignment.date)}. It's back up for grabs.`,
      );
    }
  });

  // /openshifts — text-only list, claim from Kitchen Shifts topic
  bot.command('openshifts', async (ctx) => {
    if (!isRotaEnabled(opts.registeredGroups())) return;

    const openSlots = rotaGetOpenSlots();
    const now = new Date().toISOString().slice(0, 10);
    const future = openSlots.filter((a) => a.date >= now);

    if (future.length === 0) {
      await ctx.reply('No open shifts right now.');
      return;
    }

    const lines = future.map(
      (a) => `  ${formatAssignment(a)} (${a.original_name || '???'})`,
    );
    await ctx.reply(
      `${future.length} open shift${future.length > 1 ? 's' : ''}:\n${lines.join('\n')}\n\nHead to Kitchen Shifts to claim.`,
    );
  });

  // /hands response — toast only
  bot.callbackQuery(/^rota:coming:/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: 'Thanks! Head to the kitchen.',
    });
  });
}
