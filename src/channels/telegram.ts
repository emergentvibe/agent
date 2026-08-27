import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
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

    // Single source of truth for all slash commands.
    // local: handled inside TelegramChannel, NOT forwarded to the agent.
    // agent (the default): forwarded to the agent and rewritten with the
    // trigger prefix so they match TRIGGER_PATTERN in groups.
    const COMMANDS: Array<{
      command: string;
      description: string;
      local?: boolean;
    }> = [
      { command: 'today', description: "Today's events and schedule" },
      { command: 'where', description: 'Find a place — /where kitchen' },
      {
        command: 'recall',
        description: 'Search community memory — /recall yoga',
      },
      { command: 'hello', description: 'Introduce yourself to the community' },
      { command: 'connect', description: 'Find people with shared interests' },
      {
        command: 'forget',
        description: 'Remove your introduction from memory',
      },
      { command: 'chatid', description: 'Get this chat ID', local: true },
      { command: 'ping', description: 'Check if bot is online', local: true },
    ];

    // Register all commands for Telegram autocomplete menu
    await this.bot.api.setMyCommands(
      COMMANDS.map(({ command, description }) => ({ command, description })),
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
        content,
        timestamp,
        is_from_me: false,
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
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
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

  async sendMessage(jid: string, text: string): Promise<void> {
    // Throw on failure so callers can distinguish "delivered" from "lost".
    // The caller in index.ts:processGroupMessages relies on this to decide
    // whether to roll back the message cursor and retry.
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    const numericId = jid.replace(/^tg:/, '');

    // Telegram has a 4096 character limit per message — split if needed
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(this.bot.api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          this.bot.api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info({ jid, length: text.length }, 'Telegram message sent');
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
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
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
