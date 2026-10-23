import fs from 'fs';
import path from 'path';
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onTopicDiscovered?: (
    chatJid: string,
    threadId: number | string,
    name: string,
  ) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly TYPING_REFRESH_MS = 8000;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private getDefaultChannelId(guildJid: string): string | null {
    const group = this.opts.registeredGroups()[guildJid];
    if (!group) return null;
    try {
      const configPath = path.join(
        resolveGroupFolderPath(group.folder),
        'group-config.json',
      );
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.default_channel_id || null;
    } catch {
      return null;
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;

      const isDm = message.guild === null;
      const chatJid = isDm
        ? `dc-dm:${message.author.id}`
        : `dc:${message.guild!.id}`;

      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      if (message.attachments.size > 0) {
        const descriptions = [...message.attachments.values()].map((att) => {
          const ct = att.contentType || '';
          if (ct.startsWith('image/')) return `[Image: ${att.name || 'image'}]`;
          if (ct.startsWith('video/')) return `[Video: ${att.name || 'video'}]`;
          if (ct.startsWith('audio/')) return `[Audio: ${att.name || 'audio'}]`;
          return `[File: ${att.name || 'file'}]`;
        });
        content = content
          ? `${content}\n${descriptions.join('\n')}`
          : descriptions.join('\n');
      }

      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      const isGroup = !isDm;
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'discord', isGroup);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord chat',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: isDm ? undefined : message.channelId,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Guild ID format: dc:{guildId}  |  DM format: dc-dm:{userId}\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: { thread_id?: number | string },
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      if (jid.startsWith('dc-dm:')) {
        const userId = jid.replace(/^dc-dm:/, '');
        const user = await this.client.users.fetch(userId);
        await this.splitAndSend((chunk) => user.send(chunk), text);
        logger.info({ jid, length: text.length }, 'Discord DM sent');
        return;
      }

      let targetId = opts?.thread_id?.toString();
      if (!targetId) {
        targetId = this.getDefaultChannelId(jid) ?? undefined;
        if (!targetId) {
          logger.warn(
            { jid },
            'No target channel and no default_channel_id configured',
          );
          return;
        }
      }

      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !('send' in channel)) {
        logger.warn(
          { jid, targetId },
          'Discord channel not found or not text-based',
        );
        return;
      }

      await this.splitAndSend((chunk) => (channel as TextChannel).send(chunk), text);
      logger.info(
        { jid, thread_id: opts?.thread_id, length: text.length },
        'Discord message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  private async splitAndSend(
    sendFn: (text: string) => Promise<any>,
    text: string,
  ): Promise<void> {
    const MAX_LENGTH = 2000;
    if (text.length <= MAX_LENGTH) {
      await sendFn(text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendFn(text.slice(i, i + MAX_LENGTH));
      }
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:') || jid.startsWith('dc-dm:');
  }

  async sendFile(jid: string, buffer: Buffer, filename: string): Promise<void> {
    if (!this.client) throw new Error('Discord client not initialized');

    if (jid.startsWith('dc-dm:')) {
      const userId = jid.replace(/^dc-dm:/, '');
      const user = await this.client.users.fetch(userId);
      await user.send({ files: [{ attachment: buffer, name: filename }] });
      logger.info({ jid, filename }, 'Discord file sent (DM)');
      return;
    }

    const targetId = this.getDefaultChannelId(jid);
    if (!targetId) {
      logger.warn({ jid }, 'Cannot send file: no default_channel_id');
      return;
    }
    const channel = await this.client.channels.fetch(targetId);
    if (channel && 'send' in channel) {
      await (channel as TextChannel).send({
        files: [{ attachment: buffer, name: filename }],
      });
      logger.info({ jid, filename }, 'Discord file sent');
    }
  }

  async disconnect(): Promise<void> {
    for (const handle of this.typingIntervals.values()) clearInterval(handle);
    this.typingIntervals.clear();
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }
    if (!isTyping) return;

    const client = this.client;
    const resolveChannelId = async (): Promise<string | null> => {
      if (jid.startsWith('dc-dm:')) {
        const userId = jid.replace(/^dc-dm:/, '');
        const user = await client.users.fetch(userId);
        const dmChannel = await user.createDM();
        return dmChannel.id;
      }
      return this.getDefaultChannelId(jid);
    };

    const fire = async () => {
      try {
        const channelId = await resolveChannelId();
        if (!channelId) return;
        const channel = await client.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    await fire();
    const handle = setInterval(fire, this.TYPING_REFRESH_MS);
    if (typeof handle.unref === 'function') handle.unref();
    this.typingIntervals.set(jid, handle);
  }

  async syncGroups(): Promise<void> {
    if (!this.client) return;

    for (const [jid] of Object.entries(this.opts.registeredGroups())) {
      if (!jid.startsWith('dc:') || jid.startsWith('dc-dm:')) continue;
      const guildId = jid.replace(/^dc:/, '');
      try {
        const guild = await this.client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        for (const [channelId, channel] of channels) {
          if (channel && channel.isTextBased() && !channel.isThread()) {
            this.opts.onTopicDiscovered?.(jid, channelId, channel.name);
          }
        }
        logger.info(
          { guildId, channelCount: channels.size },
          'Discord guild channels synced',
        );
      } catch (err) {
        logger.warn({ guildId, err }, 'Failed to sync Discord guild channels');
      }
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
