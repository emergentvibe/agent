/**
 * Subscription system — users subscribe to topics and get DM notifications
 * when extraction stores a matching memory.
 *
 * Storage: file-based (groups/{folder}/subscriptions.json)
 * Matching: simple keyword overlap between subscription and memory text
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

export interface Subscription {
  userId: string;
  userName: string;
  topic: string;
  chatJid: string;
  created_at: string;
}

interface SubscriptionStore {
  subscriptions: Subscription[];
}

function subscriptionsPath(groupFolder: string): string {
  return path.join(resolveGroupFolderPath(groupFolder), 'subscriptions.json');
}

function loadStore(groupFolder: string): SubscriptionStore {
  const filePath = subscriptionsPath(groupFolder);
  if (!fs.existsSync(filePath)) return { subscriptions: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { subscriptions: [] };
  }
}

function saveStore(groupFolder: string, store: SubscriptionStore): void {
  const filePath = subscriptionsPath(groupFolder);
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

export function addSubscription(
  groupFolder: string,
  userId: string,
  userName: string,
  topic: string,
  chatJid: string,
): void {
  const store = loadStore(groupFolder);
  const existing = store.subscriptions.find(
    (s) => s.userId === userId && s.topic.toLowerCase() === topic.toLowerCase(),
  );
  if (existing) return;

  store.subscriptions.push({
    userId,
    userName,
    topic: topic.toLowerCase(),
    chatJid,
    created_at: new Date().toISOString(),
  });
  saveStore(groupFolder, store);
  logger.info({ userId, topic, groupFolder }, 'Subscription added');
}

export function removeSubscription(
  groupFolder: string,
  userId: string,
  topic: string,
): boolean {
  const store = loadStore(groupFolder);
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter(
    (s) =>
      !(s.userId === userId && s.topic.toLowerCase() === topic.toLowerCase()),
  );
  if (store.subscriptions.length < before) {
    saveStore(groupFolder, store);
    logger.info({ userId, topic, groupFolder }, 'Subscription removed');
    return true;
  }
  return false;
}

export function getSubscriptions(
  groupFolder: string,
  userId?: string,
): Subscription[] {
  const store = loadStore(groupFolder);
  if (userId) {
    return store.subscriptions.filter((s) => s.userId === userId);
  }
  return store.subscriptions;
}

export function findMatchingSubscriptions(
  groupFolder: string,
  memoryText: string,
): Subscription[] {
  const store = loadStore(groupFolder);
  const textLower = memoryText.toLowerCase();
  return store.subscriptions.filter((s) => textLower.includes(s.topic));
}
