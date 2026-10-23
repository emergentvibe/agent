import { loadFeatureConfig } from '../feature-config.js';
import {
  addSubscription,
  removeSubscription,
  getSubscriptions,
} from '../subscriptions.js';
import { registerCommand } from './registry.js';

function isSubscribeEnabled(groupFolder: string | null): boolean {
  if (!groupFolder) return false;
  return loadFeatureConfig(groupFolder).commands.subscribe;
}

registerCommand({
  name: 'subscribe',
  description: 'Get notified about a topic',
  type: 'local',
  featureGate: 'subscribe',
  handler: async (ctx) => {
    if (!isSubscribeEnabled(ctx.groupFolder))
      return 'Subscriptions are not available.';
    const topic = ctx.args.trim();
    if (!topic) return 'What topic? Usage: /subscribe yoga';
    if (topic.length < 3) return 'Topic must be at least 3 characters.';
    addSubscription(
      ctx.groupFolder!,
      ctx.userId,
      ctx.userName,
      topic,
      ctx.dmJid,
    );
    return `Subscribed to "${topic}" — I'll DM you when it comes up.`;
  },
});

registerCommand({
  name: 'unsubscribe',
  description: 'Stop notifications for a topic',
  type: 'local',
  featureGate: 'subscribe',
  handler: async (ctx) => {
    if (!isSubscribeEnabled(ctx.groupFolder))
      return 'Subscriptions are not available.';
    const topic = ctx.args.trim();
    if (!topic) {
      const subs = getSubscriptions(ctx.groupFolder!, ctx.userId);
      if (subs.length === 0) return "You don't have any subscriptions.";
      const list = subs.map((s) => `• ${s.topic}`).join('\n');
      return `Your subscriptions:\n${list}\n\nTo unsubscribe: /unsubscribe [topic]`;
    }
    const removed = removeSubscription(ctx.groupFolder!, ctx.userId, topic);
    return removed
      ? `Unsubscribed from "${topic}".`
      : `You weren't subscribed to "${topic}".`;
  },
});

registerCommand({
  name: 'subscriptions',
  description: 'List your subscriptions',
  type: 'local',
  featureGate: 'subscribe',
  handler: async (ctx) => {
    if (!isSubscribeEnabled(ctx.groupFolder))
      return 'Subscriptions are not available.';
    const subs = getSubscriptions(ctx.groupFolder!, ctx.userId);
    if (subs.length === 0) {
      return "You don't have any subscriptions yet. Use /subscribe [topic] to get started.";
    }
    const lines = subs.map((s) => `• ${s.topic}`);
    return `Your subscriptions:\n${lines.join('\n')}\n\nI'll DM you when any of these come up in the group. Use /unsubscribe [topic] to remove one.`;
  },
});
