import type { Channel, NewMessage } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

interface ResponseWaiter {
  resolve: (text: string) => void;
  timeout: NodeJS.Timeout;
}

class SimChannel implements Channel {
  name = 'sim';
  private onMessage: ChannelOpts['onMessage'];
  private onChatMetadata: ChannelOpts['onChatMetadata'];
  private responses = new Map<string, string[]>();
  private waiters = new Map<string, ResponseWaiter[]>();
  private knownJids = new Set<string>();

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {}

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.responses.has(jid)) this.responses.set(jid, []);
    this.responses.get(jid)!.push(text);

    const queue = this.waiters.get(jid);
    if (queue?.length) {
      const waiter = queue.shift()!;
      clearTimeout(waiter.timeout);
      waiter.resolve(text);
    }
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sim:');
  }

  async disconnect(): Promise<void> {}

  injectMessage(
    chatJid: string,
    msg: NewMessage,
    opts?: { timestamp?: string; isGroup?: boolean },
  ): void {
    if (opts?.timestamp) msg.timestamp = opts.timestamp;
    if (!msg.timestamp) msg.timestamp = new Date().toISOString();

    if (!this.knownJids.has(chatJid)) {
      this.onChatMetadata(
        chatJid,
        msg.timestamp,
        msg.sender_name,
        'sim',
        opts?.isGroup ?? true,
      );
      this.knownJids.add(chatJid);
    }

    this.onMessage(chatJid, msg);
  }

  getResponses(jid: string): string[] {
    return this.responses.get(jid) || [];
  }

  clearResponses(jid?: string): void {
    if (jid) {
      this.responses.delete(jid);
    } else {
      this.responses.clear();
    }
  }

  waitForResponse(jid: string, timeoutMs: number = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `SimChannel: no response on ${jid} within ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      if (!this.waiters.has(jid)) this.waiters.set(jid, []);
      this.waiters.get(jid)!.push({ resolve, timeout });
    });
  }
}

let instance: SimChannel | null = null;

registerChannel('sim', (opts) => {
  if (process.env.SIM_MODE !== '1') return null;
  instance = new SimChannel(opts);
  return instance;
});

export function getSimChannel(): SimChannel {
  if (!instance) throw new Error('SimChannel not initialized — is SIM_MODE=1?');
  return instance;
}
