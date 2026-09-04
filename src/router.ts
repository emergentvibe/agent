import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const threadAttr = m.thread_id ? ` thread_id="${m.thread_id}"` : '';
    return `<message sender="${escapeXml(m.sender_name)}" sender_id="${escapeXml(m.sender)}" time="${escapeXml(displayTime)}"${threadAttr}>${escapeXml(m.content)}</message>`;
  });

  // Derive date from the latest message (not wall clock) so the context
  // header is consistent with message timestamps.
  const latest = messages[messages.length - 1];
  const refDate = latest ? new Date(latest.timestamp) : new Date();
  const currentDate = refDate.toLocaleDateString('en-CA', {
    timeZone: timezone,
  }); // YYYY-MM-DD
  const currentDay = refDate.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
  });

  const header = `<context timezone="${escapeXml(timezone)}" current_date="${escapeXml(currentDate)}" current_day="${escapeXml(currentDay)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  opts?: { thread_id?: number },
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, opts);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
