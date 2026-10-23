import { ASSISTANT_NAME } from '../config.js';
import { registerCommand } from './registry.js';

import './subscribe.js';

registerCommand({
  name: 'today',
  description: "Today's events and schedule",
  type: 'agent',
});
registerCommand({
  name: 'where',
  description: 'Find a place — /where kitchen',
  type: 'agent',
});
registerCommand({
  name: 'recall',
  description: 'Search community memory — /recall yoga',
  type: 'agent',
});
registerCommand({
  name: 'hello',
  description: 'Introduce yourself to the community',
  type: 'agent',
});
registerCommand({
  name: 'connect',
  description: 'Find people with shared interests',
  type: 'agent',
});
registerCommand({
  name: 'forget',
  description: 'Remove your introduction from memory',
  type: 'agent',
});

registerCommand({
  name: 'chatid',
  description: 'Get this chat ID',
  type: 'local',
  visible: false,
  handler: async (ctx) => `Chat ID: \`${ctx.chatJid}\``,
});

registerCommand({
  name: 'ping',
  description: 'Check if bot is online',
  type: 'local',
  visible: false,
  handler: async () => `${ASSISTANT_NAME} is online.`,
});
