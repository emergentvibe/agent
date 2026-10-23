/**
 * Admin notifications — sends DMs to the admin.
 * Used for escalation alerts, error alerts, and daily admin summaries.
 */
import { logger } from './logger.js';

type SendFn = (jid: string, text: string) => Promise<void>;

let sendFn: SendFn | null = null;
let adminJid: string | null = null;

export function initAdminNotify(
  send: SendFn,
  adminId: string | undefined,
  resolveAdminDmJid: (adminId: string) => string | null,
): void {
  sendFn = null;
  adminJid = null;

  if (!adminId) {
    logger.debug('ADMIN_ID not set — admin notifications disabled');
    return;
  }
  const jid = resolveAdminDmJid(adminId);
  if (!jid) {
    logger.warn(
      { adminId },
      'Admin has not DMed the bot — notifications disabled until they do',
    );
    return;
  }
  sendFn = send;
  adminJid = jid;
  logger.info({ adminJid }, 'Admin notifications enabled');
}

async function send(text: string): Promise<void> {
  if (!sendFn || !adminJid) return;
  try {
    await sendFn(adminJid, text);
  } catch (err) {
    logger.warn({ err, adminJid }, 'Failed to send admin notification');
  }
}

export async function notifyEscalation(
  severity: string,
  text: string,
  groupFolder: string,
): Promise<void> {
  await send(`⚠️ *Escalation* (${severity})\nGroup: ${groupFolder}\n\n${text}`);
}

export async function notifyError(
  context: string,
  error: string,
): Promise<void> {
  await send(`🔴 *Error*: ${context}\n\n${error.slice(0, 500)}`);
}

export async function notifyAdminSummary(summary: string): Promise<void> {
  await send(summary);
}

export function isAdminNotifyEnabled(): boolean {
  return sendFn !== null && adminJid !== null;
}

export function getAdminJid(): string | null {
  return adminJid;
}
