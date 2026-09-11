import fs from 'fs';
import https from 'https';
import path from 'path';
import { autoRetry } from '@grammyjs/auto-retry';
import { Api, Bot, InlineKeyboard, InputFile } from 'grammy';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  TRIGGER_PATTERN,
  ROTA_SHIFTS_TOPIC_ID,
  ROTA_GROUP_JID,
} from '../config.js';
import {
  addSubscription,
  removeSubscription,
  getSubscriptions,
} from '../subscriptions.js';
import {
  cancelLastPurchase,
  getUserPurchases,
  getUserTotal,
  isAnyPurchaseTopic,
  isPurchaseTopicForCategory,
  storePurchase,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  isRotaImportPending,
  clearRotaImportState,
  isAttendeeImportPending,
  handleAttendeeImportFile,
} from '../admin-commands.js';
import { rotaImport, rotaReset, rotaGetMeta } from '../rota-db.js';
import type { RotaImportPayload } from '../rota-db.js';
import { adaptRotaExport, type SheetRotaExport } from '../sheet-adapter.js';
import { isCrewMember } from '../crew.js';
import { loadFeatureConfig } from '../feature-config.js';
import { rotaCommandEntries, registerRotaCommands } from '../rota-commands.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onTopicDiscovered?: (chatJid: string, threadId: number, name: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // Telegram's typing state only lasts ~5s; refresh just under that.
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly TYPING_REFRESH_MS = 4000;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.bot.api.config.use(
      autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }),
    );

    const getMainGroupFolder = (): string | null => {
      const groups = this.opts.registeredGroups();
      const main = Object.values(groups).find((g) => g.isMain);
      return main?.folder ?? null;
    };

    const isPurchaseEnabled = (): boolean => {
      const folder = getMainGroupFolder();
      if (!folder) return true;
      return loadFeatureConfig(folder).commands.purchase;
    };

    const isSubscribeEnabled = (): boolean => {
      const folder = getMainGroupFolder();
      if (!folder) return true;
      return loadFeatureConfig(folder).commands.subscribe;
    };

    // Single source of truth for all slash commands.
    // local: handled inside TelegramChannel, NOT forwarded to the agent.
    // agent (the default): forwarded to the agent and rewritten with the
    // trigger prefix so they match TRIGGER_PATTERN in groups.
    // featureGate: if set, command only appears in menu when that feature is enabled.
    const COMMANDS: Array<{
      command: string;
      description: string;
      local?: boolean;
      visible?: boolean;
      featureGate?: 'purchase' | 'subscribe' | 'rota';
    }> = [
      { command: 'today', description: "Today's events and schedule" },
      { command: 'hello', description: 'Introduce yourself to the community' },
      { command: 'connect', description: 'Find people with shared interests' },
      {
        command: 'forget',
        description: 'Remove your introduction from memory',
      },
      {
        command: 'subscribe',
        description: 'Get notified about a topic',
        local: true,
        featureGate: 'subscribe',
      },
      {
        command: 'unsubscribe',
        description: 'Stop notifications for a topic',
        local: true,
        featureGate: 'subscribe',
      },
      {
        command: 'bar',
        description: 'Buy a drink',
        local: true,
        featureGate: 'purchase',
      },
      {
        command: 'bbq',
        description: 'Buy food from the grill',
        local: true,
        featureGate: 'purchase',
      },
      {
        command: 'purchase',
        description: 'Buy something',
        local: true,
        featureGate: 'purchase',
      },
      {
        command: 'show_total',
        description: 'See your tab',
        local: true,
        featureGate: 'purchase',
      },
      {
        command: 'cancel_purchase',
        description: 'Undo your last purchase',
        local: true,
        visible: false,
        featureGate: 'purchase',
      },
      {
        command: 'chatid',
        description: 'Get this chat ID',
        local: true,
        visible: false,
      },
      {
        command: 'ping',
        description: 'Check if bot is online',
        local: true,
        visible: false,
      },
      ...rotaCommandEntries(),
    ];

    // Filter commands by feature flags, then register visible ones for Telegram autocomplete.
    const mainFolder = getMainGroupFolder();
    const features = mainFolder ? loadFeatureConfig(mainFolder) : null;
    const activeCommands = COMMANDS.filter((c) => {
      if (!c.featureGate) return true;
      if (!features) return true;
      return features.commands[c.featureGate];
    });

    await this.bot.api.setMyCommands(
      activeCommands
        .filter((c) => c.visible !== false)
        .map(({ command, description }) => ({ command, description })),
    );

    const LOCAL_COMMANDS = new Set(
      COMMANDS.filter((c) => c.local).map((c) => c.command),
    );
    const AGENT_COMMANDS = new Set(
      COMMANDS.filter((c) => !c.local).map((c) => c.command),
    );

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // --- Purchase system (local, no containers) ---

    const loadPrices = (): Record<string, Record<string, number>> | null => {
      const groups = this.opts.registeredGroups();
      for (const group of Object.values(groups)) {
        const pricesPath = path.join(GROUPS_DIR, group.folder, 'prices.json');
        if (fs.existsSync(pricesPath)) {
          try {
            return JSON.parse(fs.readFileSync(pricesPath, 'utf-8'));
          } catch {
            logger.warn({ path: pricesPath }, 'Failed to parse prices.json');
          }
        }
      }
      return null;
    };

    const buildCategoryKeyboard = (
      category: string,
      items: Record<string, number>,
    ): InlineKeyboard => {
      const kb = new InlineKeyboard();
      const entries = Object.entries(items);
      for (let i = 0; i < entries.length; i++) {
        const [item, price] = entries[i];
        kb.text(`${item} €${price}`, `buy:${category}:${item}`);
        if (i % 2 === 1 && i < entries.length - 1) kb.row();
      }
      return kb;
    };

    const isPurchaseAllowed = (ctx: any, category?: 'bar' | 'bbq'): boolean => {
      if (ctx.chat?.type === 'private') return true;
      const threadId = ctx.message?.message_thread_id;
      if (!threadId) return false;
      if (category) return isPurchaseTopicForCategory(threadId, category);
      return isAnyPurchaseTopic(threadId);
    };

    const PURCHASE_REDIRECT = 'Use this in a DM with me or the right topic.';

    const PURCHASE_DISABLED = 'Purchases are not available.';

    const handlePurchaseCommand = async (ctx: any, category?: string) => {
      if (!isPurchaseEnabled()) {
        await ctx.reply(PURCHASE_DISABLED);
        return;
      }
      if (!isPurchaseAllowed(ctx, category as 'bar' | 'bbq' | undefined)) {
        await ctx.reply(PURCHASE_REDIRECT);
        return;
      }

      const prices = loadPrices();
      if (!prices) {
        await ctx.reply('No price list configured for this community.');
        return;
      }

      if (category && prices[category]) {
        const kb = buildCategoryKeyboard(category, prices[category]);
        await ctx.reply(
          `*${category.charAt(0).toUpperCase() + category.slice(1)}*`,
          {
            reply_markup: kb,
            parse_mode: 'Markdown',
          },
        );
      } else {
        const kb = new InlineKeyboard();
        for (const [cat, items] of Object.entries(prices)) {
          for (const [item, price] of Object.entries(items)) {
            kb.text(`${item} €${price}`, `buy:${cat}:${item}`);
          }
          kb.row();
        }
        await ctx.reply('*What would you like?*', {
          reply_markup: kb,
          parse_mode: 'Markdown',
        });
      }
    };

    this.bot.command('bar', (ctx) => handlePurchaseCommand(ctx, 'bar'));
    this.bot.command('bbq', (ctx) => handlePurchaseCommand(ctx, 'bbq'));
    this.bot.command('purchase', (ctx) => handlePurchaseCommand(ctx));

    this.bot.command('show_total', async (ctx) => {
      if (!isPurchaseEnabled()) {
        await ctx.reply(PURCHASE_DISABLED);
        return;
      }
      if (!isPurchaseAllowed(ctx)) {
        await ctx.reply(PURCHASE_REDIRECT);
        return;
      }
      const userId = ctx.from?.id?.toString() || '';
      const purchases = getUserPurchases(userId);
      if (purchases.length === 0) {
        await ctx.reply('No purchases yet.');
        return;
      }
      const lines = purchases.map((p) => `${p.item}: €${p.price.toFixed(2)}`);
      const total = getUserTotal(userId);
      lines.push(`\n*Total: €${total.toFixed(2)}*`);
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    this.bot.command('cancel_purchase', async (ctx) => {
      if (!isPurchaseEnabled()) {
        await ctx.reply(PURCHASE_DISABLED);
        return;
      }
      if (!isPurchaseAllowed(ctx)) {
        await ctx.reply(PURCHASE_REDIRECT);
        return;
      }
      const userId = ctx.from?.id?.toString() || '';
      const cancelled = cancelLastPurchase(userId);
      if (!cancelled) {
        await ctx.reply('Nothing to cancel.');
        return;
      }
      const total = getUserTotal(userId);
      await ctx.reply(
        `Cancelled: ${cancelled.item} (€${cancelled.price.toFixed(2)})\nNew total: €${total.toFixed(2)}`,
      );
    });

    // Handle inline keyboard button taps for purchases
    this.bot.callbackQuery(/^buy:(.+):(.+)$/, async (ctx) => {
      if (!isPurchaseEnabled()) {
        await ctx.answerCallbackQuery({ text: 'Purchases are not available.' });
        return;
      }
      const match = ctx.callbackQuery.data.match(/^buy:(.+):(.+)$/);
      if (!match) return;
      const [, category, item] = match;
      const prices = loadPrices();
      const price = prices?.[category]?.[item];
      if (price === undefined) {
        await ctx.answerCallbackQuery({ text: 'Item not available.' });
        return;
      }

      const userId = ctx.from.id.toString();
      const userName = ctx.from.first_name || ctx.from.username || userId;
      const chatJid = `tg:${ctx.callbackQuery.message?.chat.id || ''}`;

      storePurchase(chatJid, userId, userName, item, price);
      const total = getUserTotal(userId);

      await ctx.answerCallbackQuery({
        text: `Added ${item} (€${price.toFixed(2)})`,
      });
      try {
        await ctx.editMessageText(
          `${userName} bought *${item}* (€${price.toFixed(2)})\nRunning total: *€${total.toFixed(2)}*`,
          { parse_mode: 'Markdown' },
        );
      } catch {
        // Message may be too old to edit
      }
    });

    // --- Subscribe system (local, no containers) ---

    const resolveGroupFolder = (chatJid: string): string | null => {
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return null;
      return group.folder.replace(/-dm-\d+$/, '');
    };

    this.bot.command('subscribe', async (ctx) => {
      if (!isSubscribeEnabled()) {
        await ctx.reply('Subscriptions are not available.');
        return;
      }
      const chatJid = `tg:${ctx.chat.id}`;
      const groupFolder = resolveGroupFolder(chatJid);
      if (!groupFolder) {
        await ctx.reply('Subscriptions are not available in this chat.');
        return;
      }
      const topic = (ctx.match?.toString() || '').trim();
      if (!topic) {
        await ctx.reply('What topic? Usage: /subscribe yoga');
        return;
      }
      if (topic.length < 3) {
        await ctx.reply('Topic must be at least 3 characters.');
        return;
      }
      const userId = ctx.from?.id?.toString() || '';
      const userName =
        ctx.from?.first_name || ctx.from?.username || userId;
      const dmJid = `tg:${ctx.from?.id}`;
      addSubscription(groupFolder, userId, userName, topic, dmJid);
      await ctx.reply(`Subscribed to "${topic}" — I'll DM you when it comes up.`);
    });

    this.bot.command('unsubscribe', async (ctx) => {
      if (!isSubscribeEnabled()) {
        await ctx.reply('Subscriptions are not available.');
        return;
      }
      const chatJid = `tg:${ctx.chat.id}`;
      const groupFolder = resolveGroupFolder(chatJid);
      if (!groupFolder) {
        await ctx.reply('Subscriptions are not available in this chat.');
        return;
      }
      const topic = (ctx.match?.toString() || '').trim();
      if (!topic) {
        const subs = getSubscriptions(
          groupFolder,
          ctx.from?.id?.toString(),
        );
        if (subs.length === 0) {
          await ctx.reply("You don't have any subscriptions.");
        } else {
          const list = subs.map((s) => `• ${s.topic}`).join('\n');
          await ctx.reply(
            `Your subscriptions:\n${list}\n\nTo unsubscribe: /unsubscribe [topic]`,
          );
        }
        return;
      }
      const userId = ctx.from?.id?.toString() || '';
      const removed = removeSubscription(groupFolder, userId, topic);
      if (removed) {
        await ctx.reply(`Unsubscribed from "${topic}".`);
      } else {
        await ctx.reply(`You weren't subscribed to "${topic}".`);
      }
    });

    // --- Rota commands (local, no containers) ---
    const rotaGroupId = ROTA_GROUP_JID.replace(/^tg:/, '');
    registerRotaCommands(
      this.bot,
      {
        registeredGroups: this.opts.registeredGroups,
        sendToShiftsTopic: async (text, keyboard) => {
          if (!rotaGroupId || !ROTA_SHIFTS_TOPIC_ID) {
            logger.warn(
              'Rota: ROTA_GROUP_JID or ROTA_SHIFTS_TOPIC_ID not configured',
            );
            return undefined;
          }
          const msgOpts: Record<string, unknown> = {
            message_thread_id: ROTA_SHIFTS_TOPIC_ID,
            parse_mode: 'Markdown',
          };
          if (keyboard) msgOpts.reply_markup = keyboard;
          const msg = await this.bot!.api.sendMessage(
            rotaGroupId,
            text,
            msgOpts,
          );
          return msg.message_id;
        },
        editShiftsTopicMessage: async (messageId, text, keyboard) => {
          if (!rotaGroupId) return;
          const editOpts: Record<string, unknown> = {};
          if (keyboard) editOpts.reply_markup = keyboard;
          await this.bot!.api.editMessageText(
            rotaGroupId,
            messageId,
            text,
            editOpts,
          );
        },
        sendDm: async (userId, text) => {
          await sendTelegramMessage(this.bot!.api, userId, text);
        },
      },
      InlineKeyboard,
    );

    // /start deep link handler (NFC stickers, DM entry points)
    this.bot.command('start', async (ctx) => {
      const payload = ctx.match?.toString().trim();
      if (!payload) {
        const chatJid = `tg:${ctx.chat.id}`;
        const timestamp = new Date(ctx.message!.date * 1000).toISOString();
        const chatName =
          ctx.chat.type === 'private'
            ? ctx.from?.first_name || ctx.from?.username || 'DM'
            : (ctx.chat as any).title || chatJid;
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          chatName,
          'telegram',
          isGroup,
        );
        const displayName =
          [ctx.from?.first_name, ctx.from?.last_name]
            .filter(Boolean)
            .join(' ') ||
          ctx.from?.username ||
          'Unknown';
        this.opts.onMessage(chatJid, {
          id: ctx.message!.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: displayName,
          sender_handle: ctx.from?.username
            ? `@${ctx.from.username}`
            : undefined,
          content: `@${ASSISTANT_NAME} introduce yourself — this is my first message`,
          timestamp,
          is_from_me: false,
        });
        return;
      }

      switch (payload) {
        case 'bar':
        case 'bbq':
          await handlePurchaseCommand(ctx, payload);
          break;
        case 'tab': {
          if (!isPurchaseEnabled()) {
            await ctx.reply(PURCHASE_DISABLED);
            break;
          }
          const userId = ctx.from?.id?.toString() || '';
          const purchases = getUserPurchases(userId);
          if (purchases.length === 0) {
            await ctx.reply('No purchases yet.');
          } else {
            const lines = purchases.map(
              (p) => `${p.item}: €${p.price.toFixed(2)}`,
            );
            const total = getUserTotal(userId);
            lines.push(`\n*Total: €${total.toFixed(2)}*`);
            await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
          }
          break;
        }
        default:
          // Other payloads (wifi, today, info, connect) → rewrite as agent command
          this.opts.onMessage(`tg:${ctx.chat.id}`, {
            id: ctx.message!.message_id.toString(),
            chat_jid: `tg:${ctx.chat.id}`,
            sender: ctx.from?.id?.toString() || '',
            sender_name:
              ctx.from?.first_name || ctx.from?.username || 'Unknown',
            sender_handle: ctx.from?.username
              ? `@${ctx.from.username}`
              : undefined,
            content: `@${ASSISTANT_NAME} /${payload}`,
            timestamp: new Date(ctx.message!.date * 1000).toISOString(),
            is_from_me: false,
          });
          break;
      }
    });

    // Auto-discover forum topics from service messages
    this.bot.on('message:forum_topic_created', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const threadId = ctx.message.message_thread_id;
      const name =
        (ctx.message as any).forum_topic_created?.name || `Topic ${threadId}`;
      if (threadId && this.opts.onTopicDiscovered) {
        this.opts.onTopicDiscovered(chatJid, threadId, name);
        logger.info({ chatJid, threadId, name }, 'Forum topic discovered');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      logger.debug(
        {
          chatId: ctx.chat.id,
          chatType: ctx.chat.type,
          text: ctx.message.text.slice(0, 50),
        },
        'Telegram message:text event received',
      );

      // Parse /cmd or /cmd@botname — LOCAL commands are handled by
      // bot.command() above, skip them here so they aren't also stored.
      // AGENT commands fall through and are rewritten below with the
      // trigger prefix so they match TRIGGER_PATTERN in non-main groups.
      let parsedCmd: string | null = null;
      if (ctx.message.text.startsWith('/')) {
        parsedCmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (LOCAL_COMMANDS.has(parsedCmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Rewrite registered agent slash commands so they match TRIGGER_PATTERN
      // in groups where the agent requires an @mention / trigger prefix.
      // Without this, /today etc. show up in Telegram autocomplete but
      // silently fail the trigger check at index.ts:461-469.
      if (
        parsedCmd &&
        AGENT_COMMANDS.has(parsedCmd) &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups or private chats
      // (private chats may trigger DM auto-registration in the router)
      const group = this.opts.registeredGroups()[chatJid];
      if (!group && isGroup) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        sender_handle: ctx.from?.username ? `@${ctx.from.username}` : undefined,
        content,
        timestamp,
        is_from_me: false,
        thread_id: ctx.message.message_thread_id,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        thread_id: ctx.message.message_thread_id,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      const sender = ctx.from?.id?.toString() || '';
      const isDm = ctx.chat.type === 'private';

      if (isDm && name.endsWith('.json') && isRotaImportPending(sender)) {
        await this.handleRotaFileUpload(ctx);
        return;
      }

      if (isDm && name.endsWith('.json') && isAttendeeImportPending(sender)) {
        await this.handleAttendeeFileUpload(ctx);
        return;
      }

      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  private async handleRotaFileUpload(ctx: any): Promise<void> {
    const sender = ctx.from?.id?.toString() || '';
    clearRotaImportState();

    // Crew gate — silently ignore non-crew
    const groups = this.opts.registeredGroups();
    const mainGroup = Object.values(groups).find((g) => g.isMain);
    if (mainGroup && !isCrewMember(mainGroup.folder, sender)) {
      logger.warn({ sender }, 'Non-crew member attempted rota import');
      return;
    }

    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        await ctx.reply('Failed to download the file.');
        return;
      }

      const text = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        await ctx.reply('Invalid JSON. Check the file and try again.');
        return;
      }

      let payload: RotaImportPayload;
      if (parsed.schema_version) {
        try {
          payload = adaptRotaExport(parsed as SheetRotaExport, {
            allowTest: true,
          });
          if (parsed.is_test) {
            await ctx.reply(
              `Note: this is a test rota (${parsed.test_reason || 'is_test=true'}). Importing anyway.`,
            );
          }
        } catch (err: any) {
          await ctx.reply(`Sheet adapter failed: ${err.message}`);
          return;
        }
      } else {
        payload = parsed as RotaImportPayload;
      }

      if (!payload.version || !payload.assignments || !payload.blocks) {
        await ctx.reply(
          'Missing required fields (version, assignments, blocks). Is this the right file?',
        );
        return;
      }

      const existing = rotaGetMeta();
      if (existing && existing.version !== payload.version) {
        rotaReset();
        logger.info(
          { old: existing.version, new: payload.version },
          'Auto-reset rota for new version import',
        );
      }

      const result = rotaImport(payload);
      const verb = result.replaced ? 'Replaced' : 'Imported';
      await ctx.reply(
        `${verb} ${result.inserted} assignments (version: ${payload.version}).`,
      );
      logger.info(
        {
          version: payload.version,
          count: result.inserted,
          replaced: result.replaced,
        },
        'Rota imported via Telegram file upload',
      );
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      await ctx.reply(`Import failed: ${msg}`);
      logger.error({ err: msg, sender }, 'Rota import failed');
    }
  }

  private async handleAttendeeFileUpload(ctx: any): Promise<void> {
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        await ctx.reply('Failed to download the file.');
        return;
      }

      const text = await response.text();
      const result = handleAttendeeImportFile(text);
      if (result.response) {
        await ctx.reply(result.response);
      }
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      await ctx.reply(`Attendee import failed: ${msg}`);
      logger.error({ err: msg }, 'Attendee import failed');
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: { thread_id?: number },
  ): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    const numericId = jid.replace(/^tg:/, '');

    // Build thread options — General topic (thread_id=1) must be omitted
    // because Telegram rejects sendMessage with message_thread_id=1.
    const threadOpts: { message_thread_id?: number } = {};
    if (opts?.thread_id && opts.thread_id !== 1) {
      threadOpts.message_thread_id = opts.thread_id;
    }

    // Telegram has a 4096 character limit per message — split if needed
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(this.bot.api, numericId, text, threadOpts);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          this.bot.api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
          threadOpts,
        );
      }
    }
    logger.info(
      { jid, thread_id: opts?.thread_id, length: text.length },
      'Telegram message sent',
    );
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async sendFile(jid: string, buffer: Buffer, filename: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const numericId = jid.replace(/^tg:/, '');
    await this.bot.api.sendDocument(numericId, new InputFile(buffer, filename));
    logger.info({ jid, filename }, 'Telegram file sent');
  }

  async disconnect(): Promise<void> {
    for (const handle of this.typingIntervals.values()) clearInterval(handle);
    this.typingIntervals.clear();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');

    // Always clear any existing interval first — idempotent, prevents duplicates
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }
    if (!isTyping) return;

    const bot = this.bot;
    const fire = async () => {
      try {
        await bot.api.sendChatAction(numericId, 'typing');
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      }
    };

    // Fire once immediately, then refresh on interval
    await fire();
    const handle = setInterval(fire, this.TYPING_REFRESH_MS);
    if (typeof handle.unref === 'function') handle.unref();
    this.typingIntervals.set(jid, handle);
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  if (process.env.SIM_MODE === '1') return null;
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
