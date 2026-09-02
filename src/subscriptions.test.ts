import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  addSubscription,
  removeSubscription,
  getSubscriptions,
  findMatchingSubscriptions,
} from './subscriptions.js';

const TEST_GROUP = 'test-subscriptions';
const TEST_DIR = path.join(process.cwd(), 'groups', TEST_GROUP);
const SUBS_FILE = path.join(TEST_DIR, 'subscriptions.json');

describe('subscriptions', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    if (fs.existsSync(SUBS_FILE)) fs.unlinkSync(SUBS_FILE);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('adds a subscription', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'dinner', 'tg:dm-user1');
    const subs = getSubscriptions(TEST_GROUP);
    expect(subs).toHaveLength(1);
    expect(subs[0].topic).toBe('dinner');
    expect(subs[0].userId).toBe('user1');
  });

  it('deduplicates subscriptions', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'dinner', 'tg:dm-user1');
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'dinner', 'tg:dm-user1');
    expect(getSubscriptions(TEST_GROUP)).toHaveLength(1);
  });

  it('allows different topics from same user', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'dinner', 'tg:dm-user1');
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'yoga', 'tg:dm-user1');
    expect(getSubscriptions(TEST_GROUP)).toHaveLength(2);
  });

  it('removes a subscription', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'dinner', 'tg:dm-user1');
    const removed = removeSubscription(TEST_GROUP, 'user1', 'dinner');
    expect(removed).toBe(true);
    expect(getSubscriptions(TEST_GROUP)).toHaveLength(0);
  });

  it('returns false when removing nonexistent subscription', () => {
    const removed = removeSubscription(TEST_GROUP, 'user1', 'dinner');
    expect(removed).toBe(false);
  });

  it('filters subscriptions by user', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'dinner', 'tg:dm-user1');
    addSubscription(TEST_GROUP, 'user2', 'Sam', 'dinner', 'tg:dm-user2');
    expect(getSubscriptions(TEST_GROUP, 'user1')).toHaveLength(1);
    expect(getSubscriptions(TEST_GROUP, 'user2')).toHaveLength(1);
  });

  it('finds matching subscriptions', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'dinner', 'tg:dm-user1');
    addSubscription(TEST_GROUP, 'user2', 'Sam', 'yoga', 'tg:dm-user2');

    const matches = findMatchingSubscriptions(
      TEST_GROUP,
      'Dinner moved from 7pm to 6:30pm',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].userId).toBe('user1');
  });

  it('case-insensitive matching', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'Dinner', 'tg:dm-user1');
    const matches = findMatchingSubscriptions(
      TEST_GROUP,
      'dinner is at 6pm tonight',
    );
    expect(matches).toHaveLength(1);
  });

  it('returns empty for no matches', () => {
    addSubscription(TEST_GROUP, 'user1', 'Alex', 'yoga', 'tg:dm-user1');
    const matches = findMatchingSubscriptions(
      TEST_GROUP,
      'Dinner moved to 6pm',
    );
    expect(matches).toHaveLength(0);
  });
});
