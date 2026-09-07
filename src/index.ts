import fs from 'fs';
import path from 'path';

import {
  handleAdminCommand,
  isDegraded,
  isSilenced,
} from './admin-commands.js';
import {
  attendeeCheckIn,
  attendeeLookupByHandle,
  attendeeLookupByName,
  attendeeLookupByTelegramDisplay,
  attendeeLookupByTelegramId,
  isAttendeeAdmin,
  type AttendeeRecord,
} from './attendee-db.js';
import { startAdminHttp } from './admin-http.js';
import {
  initAdminNotify,
  notifyAdminSummary,
  notifyError,
} from './admin-notify.js';
import {
  ADMIN_HTTP_PORT,
  ADMIN_HTTP_TOKEN,
  ADMIN_TELEGRAM_ID,
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  ROTA_GROUP_JID,
  ROTA_SHIFTS_TOPIC_ID,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChatMetadata,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  hasSenderInChat,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  upsertTopic,
} from './db.js';

import { ensureCrewDigestTask, ensureDigestTask } from './digest.js';
import {
  findCommunityForUser,
  sanitizeForFolder,
  writeDmClaudeMd,
} from './dm-registration.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { syncAll } from '../governance/sync/constitution-sync.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { storeMemory } from './mem0-client.js';
import { startExtractionLoop } from './extraction.js';
import {
  rotaGetByTelegramId,
  rotaGetByHandle,
  rotaBindTelegramId,
} from './rota-db.js';
import { startRotaReminders, stopRotaReminders } from './rota-reminders.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let lastReplyThreadId: Record<string, number | undefined> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];

function resolveAttendee(
  telegramId: string,
  senderName?: string,
  senderHandle?: string,
): AttendeeRecord | null {
  // 1. Telegram ID (returning user)
  const byId = attendeeLookupByTelegramId(telegramId);
  if (byId) return byId;

  // 2. @handle match
  if (senderHandle) {
    const byHandle = attendeeLookupByHandle(senderHandle);
    if (byHandle) return byHandle;
  }

  // 3. Telegram display name match (from sheet export)
  if (senderName) {
    const byDisplay = attendeeLookupByTelegramDisplay(senderName);
    if (byDisplay) return byDisplay;
  }

  // 4. Name match (exact, then fuzzy first-name)
  if (senderName) {
    const byName = attendeeLookupByName(senderName);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      logger.info(
        { senderName, matchCount: byName.length },
        'Ambiguous attendee name match — registering as walk-in',
      );
    }
  }

  return null;
}

function bindRotaIdentity(
  telegramId: string,
  handle?: string,
): string | undefined {
  let shifts = rotaGetByTelegramId(telegramId);
  if (shifts.length === 0 && handle) {
    const normalized = handle.startsWith('@') ? handle : `@${handle}`;
    shifts = rotaGetByHandle(normalized);
    if (shifts.length > 0) {
      rotaBindTelegramId(normalized, telegramId);
      logger.info(
        { handle: normalized, telegramId },
        'Rota identity bound at check-in',
      );
    }
  }

  if (shifts.length === 0) return undefined;

  const future = shifts.filter(
    (s) => s.date >= new Date().toISOString().slice(0, 10),
  );
  if (future.length === 0) return undefined;

  const lines = future
    .slice(0, 8)
    .map(
      (s) => `- ${s.block_label} ${s.start}–${s.end}, ${s.date} (${s.state})`,
    );
  return `This person has ${future.length} upcoming kitchen shift${future.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function buildPersonalContext(
  attendee: AttendeeRecord | null,
  rotaSummary?: string,
): string | undefined {
  const parts: string[] = [];

  if (attendee) {
    parts.push(`This is ${attendee.name}.`);
    if (attendee.role === 'crew') {
      parts.push('They are a crew member (kitchen team).');
    } else if (attendee.role === 'organizer') {
      parts.push(
        'They are an organizer. Treat them as crew with admin-level trust.',
      );
    }
    if (attendee.arrival || attendee.departure) {
      const dates = [
        attendee.arrival ? `arrives ${attendee.arrival}` : '',
        attendee.departure ? `departs ${attendee.departure}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      parts.push(`Schedule: ${dates}.`);
    }
  }

  if (rotaSummary) {
    parts.push(rotaSummary);
    parts.push(
      'Mention their shifts in the welcome message. Remind them about /myrota and /cover.',
    );
  }

  return parts.length > 0 ? parts.join('\n') : undefined;
}
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Ensure scheduled tasks (digest, etc.) for this group
  if (group.isMain) {
    ensureDigestTask(group, jid);
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  if (isSilenced()) return true;

  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  if (isDegraded()) {
    const sinceTs = lastAgentTimestamp[chatJid] || '';
    const msgs = getMessagesSince(chatJid, sinceTs, ASSISTANT_NAME);
    if (msgs.length > 0) {
      const hasTrigger = msgs.some((m) =>
        TRIGGER_PATTERN.test(m.content.trim()),
      );
      if (hasTrigger) {
        const triggerMsg = [...msgs]
          .reverse()
          .find((m) => TRIGGER_PATTERN.test(m.content.trim()));
        await channel.sendMessage(
          chatJid,
          "I'm taking a short break — back soon.",
          { thread_id: triggerMsg?.thread_id },
        );
      }
      lastAgentTimestamp[chatJid] = msgs[msgs.length - 1].timestamp;
      saveState();
    }
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // All groups (except DMs with requiresTrigger:false) need @bot or /slash trigger
  if (group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Find the thread_id of the trigger message so replies go to the correct topic.
  // For DMs (requiresTrigger:false), use the last message's thread_id.
  // Stored in lastReplyThreadId so piped messages can update it.
  const triggerMsg =
    group.requiresTrigger !== false
      ? [...missedMessages]
          .reverse()
          .find((m) => TRIGGER_PATTERN.test(m.content.trim()))
      : missedMessages[missedMessages.length - 1];
  lastReplyThreadId[chatJid] = triggerMsg?.thread_id;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  try {
    const output = await runAgent(group, prompt, chatJid, async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        // Detect silence indicators — bot should say nothing, not narrate staying quiet
        const silencePattern =
          /^(\*?\s*(stays?\s+quiet|stays?\s+silent|silence|listening|says?\s+nothing|no\s+response|\.{3}|🤐|—)\s*\*?\s*){1,2}$/i;
        const bracketSilence =
          /^\[.*?(no response|silence|listening|not respond|casual).*?\]$/is;
        const isSilence =
          silencePattern.test(text) || bracketSilence.test(text);
        logger.info(
          { group: group.name, isSilence },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text && !isSilence) {
          try {
            await channel.sendMessage(chatJid, text, {
              thread_id: lastReplyThreadId[chatJid],
            });
            outputSentToUser = true;
          } catch (err) {
            // Channel rejected the send — don't mark as delivered.
            // hadError triggers the rollback path below so retries can
            // re-run this batch of messages.
            logger.error(
              { err, group: group.name },
              'Failed to deliver agent output to channel',
            );
            hadError = true;
          }
        }
        // Stop typing after each output — the container stays alive for
        // follow-up messages, but the user shouldn't see "typing..." after
        // the reply lands. If a new message arrives, line 551 re-enables it.
        await channel.setTyping?.(chatJid, false).catch(() => {});
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    if (output === 'error' || hadError) {
      // If we already sent output to the user, don't roll back the cursor —
      // the user got their response and re-processing would send duplicates.
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  } finally {
    // Always clear typing indicator and idle timer, even if runAgent throws.
    // setTyping(false) also cancels the typing refresh interval from Fix #3.
    await channel.setTyping?.(chatJid, false).catch(() => {});
    if (idleTimer) clearTimeout(idleTimer);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Select model: DMs get DM_MODEL (default Sonnet), groups get GROUP_MODEL (default Haiku)
  const isDm = !isMain && group.folder.includes('-dm-');
  const model = isDm
    ? process.env.DM_MODEL || process.env.CLAUDE_MODEL
    : process.env.GROUP_MODEL || process.env.CLAUDE_MODEL;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        isDm,
        assistantName: ASSISTANT_NAME,
        model: model || undefined,
        mcpServers: group.containerConfig?.mcpServers,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      notifyError(
        `Container error (${group.name})`,
        output.error || 'Unknown error',
      ).catch(() => {});
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    notifyError(
      `Agent crash (${group.name})`,
      err instanceof Error ? err.message : String(err),
    ).catch(() => {});
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Update reply thread_id so responses go to the topic of the latest trigger
            const pipedTrigger = needsTrigger
              ? [...messagesToSend]
                  .reverse()
                  .find((m) => TRIGGER_PATTERN.test(m.content.trim()))
              : messagesToSend[messagesToSend.length - 1];
            if (pipedTrigger?.thread_id !== undefined) {
              lastReplyThreadId[chatJid] = pipedTrigger.thread_id;
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

export async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Sync constitutions at startup (writes CLAUDE.md to group folders)
  try {
    await syncAll();
    logger.info('Constitution sync complete');
  } catch (err) {
    logger.warn(
      { err },
      'Constitution sync failed, using cached CLAUDE.md files',
    );
  }

  // Ensure scheduled tasks for existing groups (e.g. digest after feature flag change)
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.isMain) {
      ensureDigestTask(group, jid);
    }
  }

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start admin HTTP server (kill switch + status)
  let adminServer: import('http').Server | undefined;
  if (ADMIN_HTTP_TOKEN) {
    adminServer = await startAdminHttp(ADMIN_HTTP_PORT, ADMIN_HTTP_TOKEN);
  } else {
    logger.warn('ADMIN_HTTP_TOKEN not set — admin HTTP endpoint disabled');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopRotaReminders();
    proxyServer.close();
    adminServer?.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Admin commands — intercept before storage (DM only)
      const trimmed = msg.content.trim();
      if (trimmed.startsWith('/admin-')) {
        const channel = findChannel(channels, chatJid);
        handleAdminCommand(trimmed, msg.sender, ADMIN_TELEGRAM_ID)
          .then((result) => {
            if (!result.handled) return;
            if (result.file && channel?.sendFile) {
              channel
                .sendFile(chatJid, result.file.buffer, result.file.filename)
                .catch((err) =>
                  logger.warn({ err }, 'Failed to send admin file'),
                );
            } else if (result.response && channel) {
              channel
                .sendMessage(chatJid, result.response)
                .catch((err) =>
                  logger.warn({ err }, 'Failed to send admin command response'),
                );
            }
          })
          .catch((err) => logger.warn({ err }, 'Admin command handler error'));
        return;
      }

      // Remote control commands — intercept before storage
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);

      // Auto-register DMs from community members
      if (!registeredGroups[chatJid]) {
        const chatMeta = getChatMetadata(chatJid);
        if (chatMeta && chatMeta.is_group === 0) {
          let community = findCommunityForUser(
            msg.sender,
            registeredGroups,
            hasSenderInChat,
          );

          // Fallback: attendee registry or single-community for NFC walk-ins
          let attendee: AttendeeRecord | null = null;
          if (!community) {
            attendee = resolveAttendee(
              msg.sender,
              msg.sender_name,
              msg.sender_handle,
            );
            const mainGroups = Object.entries(registeredGroups).filter(
              ([, g]) => g.isMain,
            );
            if (mainGroups.length === 1) {
              const [jid, group] = mainGroups[0];
              const claudeMdPath = path.join(
                resolveGroupFolderPath(group.folder),
                'CLAUDE.md',
              );
              let slug = group.folder;
              if (fs.existsSync(claudeMdPath)) {
                const content = fs.readFileSync(claudeMdPath, 'utf-8');
                const slugMatch = content.match(
                  /constitution_slug:\s*"([^"]+)"/,
                );
                if (slugMatch) slug = slugMatch[1];
              }
              community = { jid, group, slug };
            }
          }

          if (community) {
            // Check in attendee if matched
            if (attendee && !attendee.checked_in) {
              attendeeCheckIn(attendee.id, msg.sender);
              const roleSuffix =
                attendee.role !== 'attendee' ? ` [${attendee.role}]` : '';
              notifyAdminSummary(
                `Check-in: ${attendee.name} (${attendee.telegram_handle || 'no handle'})${roleSuffix}`,
              ).catch(() => {});
              logger.info(
                {
                  attendee: attendee.name,
                  role: attendee.role,
                  sender: msg.sender,
                },
                'Attendee checked in via /start',
              );
            } else if (!attendee) {
              // Walk-in — no attendee match
              notifyAdminSummary(
                `Walk-in check-in: "${msg.sender_name || 'Unknown'}" (ID: ${msg.sender}, no handle). Registered as walk-in.`,
              ).catch(() => {});
              logger.info(
                { sender: msg.sender, senderName: msg.sender_name },
                'Walk-in registered (no attendee match)',
              );
            }

            // Lazy-bind rota identity
            const rotaSummary = bindRotaIdentity(
              msg.sender,
              attendee?.telegram_handle || undefined,
            );

            const personalContext = buildPersonalContext(attendee, rotaSummary);

            const dmFolder = `${community.group.folder}-dm-${sanitizeForFolder(msg.sender)}`;
            registerGroup(chatJid, {
              name: attendee?.name || msg.sender_name || chatJid,
              folder: dmFolder,
              trigger: ASSISTANT_NAME,
              added_at: new Date().toISOString(),
              requiresTrigger: false,
              containerConfig: {
                additionalMounts: [
                  {
                    hostPath: path.join(
                      resolveGroupFolderPath(community.group.folder),
                      'community-knowledge',
                    ),
                    containerPath: 'community-knowledge',
                    readonly: true,
                  },
                ],
              },
            });
            writeDmClaudeMd(
              dmFolder,
              community.group.name,
              attendee?.name || msg.sender_name || msg.sender,
              msg.sender,
              community.slug,
              undefined,
              undefined,
              personalContext,
            );
            logger.info(
              {
                chatJid,
                sender: msg.sender,
                community: community.group.name,
                dmFolder,
                attendeeName: attendee?.name,
              },
              'Auto-registered DM',
            );

            const adminIds = (ADMIN_TELEGRAM_ID || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            if (
              adminIds.includes(msg.sender) ||
              isAttendeeAdmin(msg.sender)
            ) {
              ensureCrewDigestTask(community.group, chatJid, msg.sender);
            }
          }
        }
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    onTopicDiscovered: (chatJid: string, threadId: number, name: string) =>
      upsertTopic(chatJid, threadId, name),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Init admin notifications (sends DMs to admin for escalations, errors)
  initAdminNotify(async (jid, text) => {
    const ch = findChannel(channels, jid);
    if (!ch) {
      logger.warn({ jid }, 'No channel for admin JID');
      return;
    }
    await ch.sendMessage(jid, text);
  }, ADMIN_TELEGRAM_ID);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);

  // Background memory extraction from group chat (runs on interval, no container)
  startExtractionLoop({
    registeredGroups: () => registeredGroups,
    assistantName: ASSISTANT_NAME,
  });

  // Rota shift reminders (morning announcement + DM pings before shifts)
  startRotaReminders({
    sendToShiftsTopic: async (text) => {
      if (!ROTA_GROUP_JID || !ROTA_SHIFTS_TOPIC_ID) return;
      const ch = findChannel(channels, ROTA_GROUP_JID);
      if (!ch) return;
      await ch.sendMessage(ROTA_GROUP_JID, text, {
        thread_id: ROTA_SHIFTS_TOPIC_ID,
      });
    },
    sendDm: async (userId, text) => {
      const jid = `tg:${userId}`;
      const ch = findChannel(channels, jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel for rota DM ping');
        return;
      }
      await ch.sendMessage(jid, text);
    },
  });

  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
