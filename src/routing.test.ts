import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  cancelLastPurchase,
  getAllChats,
  getAllPurchaseTotals,
  getUserPurchases,
  getUserTotal,
  getTopics,
  isExtractionEnabled,
  setTopicExtraction,
  storeChatMetadata,
  storeMessage,
  storePurchase,
  upsertTopic,
  getMessagesSince,
} from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- thread_id storage and retrieval ---

describe('thread_id in messages', () => {
  it('stores and retrieves thread_id', () => {
    storeChatMetadata(
      'tg:group1',
      '2026-01-01T00:00:00Z',
      'Test',
      'telegram',
      true,
    );
    storeMessage({
      id: 'msg1',
      chat_jid: 'tg:group1',
      sender: 'user1',
      sender_name: 'Alice',
      content: 'hello from topic',
      timestamp: '2026-01-01T00:01:00Z',
      is_from_me: false,
      thread_id: 42,
    });

    const msgs = getMessagesSince('tg:group1', '2026-01-01T00:00:00Z', 'Bot');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thread_id).toBe(42);
  });

  it('returns null thread_id for messages without topics', () => {
    storeChatMetadata(
      'tg:group1',
      '2026-01-01T00:00:00Z',
      'Test',
      'telegram',
      true,
    );
    storeMessage({
      id: 'msg2',
      chat_jid: 'tg:group1',
      sender: 'user1',
      sender_name: 'Alice',
      content: 'hello from general',
      timestamp: '2026-01-01T00:01:00Z',
      is_from_me: false,
    });

    const msgs = getMessagesSince('tg:group1', '2026-01-01T00:00:00Z', 'Bot');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thread_id).toBeNull();
  });
});

// --- formatMessages date injection ---

import { formatMessages } from './router.js';

describe('formatMessages thread_id', () => {
  it('includes thread_id attribute when present', () => {
    const messages = [
      {
        id: '1',
        chat_jid: 'tg:123',
        sender: '456',
        sender_name: 'Alice',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00.000Z',
        is_from_me: false,
        thread_id: 42,
      },
    ];

    const result = formatMessages(messages, 'UTC');
    expect(result).toContain('thread_id="42"');
  });

  it('omits thread_id attribute when absent', () => {
    const messages = [
      {
        id: '1',
        chat_jid: 'tg:123',
        sender: '456',
        sender_name: 'Alice',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00.000Z',
        is_from_me: false,
      },
    ];

    const result = formatMessages(messages, 'UTC');
    expect(result).not.toContain('thread_id');
  });
});

describe('formatMessages date injection', () => {
  it('includes current_date and current_day in context header', () => {
    const messages = [
      {
        id: '1',
        chat_jid: 'tg:123',
        sender: '456',
        sender_name: 'Alice',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00.000Z',
        is_from_me: false,
      },
    ];

    const result = formatMessages(messages, 'Europe/Athens');

    expect(result).toMatch(/current_date="\d{4}-\d{2}-\d{2}"/);
    expect(result).toMatch(
      /current_day="(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"/,
    );
  });

  it('respects timezone for date calculation', () => {
    // Mock a time near midnight UTC where date differs by timezone
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T23:30:00.000Z')); // 23:30 UTC

    const messages = [
      {
        id: '1',
        chat_jid: 'tg:123',
        sender: '456',
        sender_name: 'Alice',
        content: 'hello',
        timestamp: '2026-03-29T23:30:00.000Z',
        is_from_me: false,
      },
    ];

    // Tokyo is UTC+9, so 23:30 UTC = 08:30 next day (March 30)
    const tokyoResult = formatMessages(messages, 'Asia/Tokyo');
    expect(tokyoResult).toContain('current_date="2026-03-30"');
    expect(tokyoResult).toContain('current_day="Monday"');

    // Los Angeles is UTC-7, so 23:30 UTC = 16:30 same day (March 29)
    const laResult = formatMessages(messages, 'America/Los_Angeles');
    expect(laResult).toContain('current_date="2026-03-29"');
    expect(laResult).toContain('current_day="Sunday"');

    vi.useRealTimers();
  });
});

// --- Topic registry ---

describe('topic registry', () => {
  it('upserts and retrieves topics', () => {
    upsertTopic('tg:123', 2, 'Kitchen');
    upsertTopic('tg:123', 3, 'Events');

    const topics = getTopics('tg:123');
    expect(topics).toHaveLength(2);
    expect(topics[0].name).toBe('Kitchen');
    expect(topics[1].name).toBe('Events');
  });

  it('updates topic name on re-upsert', () => {
    upsertTopic('tg:123', 2, 'Kitchen');
    upsertTopic('tg:123', 2, 'Kitchen & Dining');

    const topics = getTopics('tg:123');
    expect(topics).toHaveLength(1);
    expect(topics[0].name).toBe('Kitchen & Dining');
  });

  it('extraction defaults to off for non-General topics', () => {
    upsertTopic('tg:123', 2, 'Pics');
    expect(isExtractionEnabled('tg:123', 2)).toBe(false);
  });

  it('General topic (null/undefined/1) always enabled', () => {
    expect(isExtractionEnabled('tg:123', null)).toBe(true);
    expect(isExtractionEnabled('tg:123', undefined)).toBe(true);
    expect(isExtractionEnabled('tg:123', 1)).toBe(true);
  });

  it('toggles extraction on/off', () => {
    upsertTopic('tg:123', 2, 'Kitchen');
    setTopicExtraction('tg:123', 2, true);
    expect(isExtractionEnabled('tg:123', 2)).toBe(true);

    setTopicExtraction('tg:123', 2, false);
    expect(isExtractionEnabled('tg:123', 2)).toBe(false);
  });
});

// --- Purchase tracking ---

describe('purchase tracking', () => {
  it('stores and retrieves purchases', () => {
    storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
    storePurchase('tg:123', 'user1', 'Alice', 'wine', 5);

    const purchases = getUserPurchases('user1');
    expect(purchases).toHaveLength(2);
    expect(purchases[0].item).toBe('beer');
    expect(purchases[1].item).toBe('wine');
  });

  it('calculates user total', () => {
    storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
    storePurchase('tg:123', 'user1', 'Alice', 'wine', 5);

    expect(getUserTotal('user1')).toBe(8);
  });

  it('calculates all totals', () => {
    storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
    storePurchase('tg:123', 'user2', 'Bob', 'burger', 5);

    const totals = getAllPurchaseTotals();
    expect(totals).toHaveLength(2);
    expect(totals[0].user_name).toBe('Bob');
    expect(totals[0].total).toBe(5);
    expect(totals[1].user_name).toBe('Alice');
    expect(totals[1].total).toBe(3);
  });

  it('cancels last purchase', () => {
    storePurchase('tg:123', 'user1', 'Alice', 'beer', 3);
    storePurchase('tg:123', 'user1', 'Alice', 'wine', 5);

    const cancelled = cancelLastPurchase('user1');
    expect(cancelled?.item).toBe('wine');
    expect(getUserTotal('user1')).toBe(3);
    expect(getUserPurchases('user1')).toHaveLength(1);
  });

  it('returns null when nothing to cancel', () => {
    expect(cancelLastPurchase('nonexistent')).toBeNull();
  });

  it('returns zero total for unknown user', () => {
    expect(getUserTotal('unknown')).toBe(0);
  });
});

// --- Outbound routing ---

import {
  routeOutbound,
  findChannel,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import type { Channel } from './types.js';

function fakeChannel(prefix: string, connected = true): Channel {
  return {
    name: `${prefix}-channel`,
    ownsJid: (jid: string) => jid.startsWith(prefix),
    isConnected: () => connected,
    sendMessage: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
}

describe('routeOutbound', () => {
  it('routes to the correct channel by JID prefix', async () => {
    const tg = fakeChannel('tg:');
    const wa = fakeChannel('wa:');

    await routeOutbound([tg, wa], 'tg:-100123', 'hello');
    expect(tg.sendMessage).toHaveBeenCalledWith(
      'tg:-100123',
      'hello',
      undefined,
    );
    expect(wa.sendMessage).not.toHaveBeenCalled();
  });

  it('passes thread_id through to channel', async () => {
    const tg = fakeChannel('tg:');

    await routeOutbound([tg], 'tg:-100', 'reply', { thread_id: 42 });
    expect(tg.sendMessage).toHaveBeenCalledWith('tg:-100', 'reply', {
      thread_id: 42,
    });
  });

  it('throws when no channel matches JID', () => {
    const tg = fakeChannel('tg:');
    expect(() => routeOutbound([tg], 'dc:999', 'oops')).toThrow(
      'No channel for JID',
    );
  });

  it('skips disconnected channels', () => {
    const disconnected = fakeChannel('tg:', false);
    const connected = fakeChannel('tg:', true);

    routeOutbound([disconnected, connected], 'tg:-100', 'test');
    expect(disconnected.sendMessage).not.toHaveBeenCalled();
    expect(connected.sendMessage).toHaveBeenCalled();
  });
});

describe('findChannel', () => {
  it('returns the channel that owns the JID', () => {
    const tg = fakeChannel('tg:');
    const wa = fakeChannel('wa:');
    expect(findChannel([tg, wa], 'wa:123')).toBe(wa);
  });

  it('returns undefined when no channel matches', () => {
    const tg = fakeChannel('tg:');
    expect(findChannel([tg], 'dc:123')).toBeUndefined();
  });
});

describe('formatOutbound', () => {
  it('strips internal tags', () => {
    expect(formatOutbound('<internal>debug</internal>Hello!')).toBe('Hello!');
  });

  it('returns empty string when only internal tags', () => {
    expect(formatOutbound('<internal>all hidden</internal>')).toBe('');
  });

  it('returns text unchanged without internal tags', () => {
    expect(formatOutbound('Just a message')).toBe('Just a message');
  });
});

describe('stripInternalTags', () => {
  it('handles multiple internal blocks', () => {
    const input =
      'before<internal>hidden1</internal>mid<internal>hidden2</internal>after';
    expect(stripInternalTags(input)).toBe('beforemidafter');
  });

  it('handles multiline internal content', () => {
    const input = 'hello<internal>\nline1\nline2\n</internal>world';
    expect(stripInternalTags(input)).toBe('helloworld');
  });
});
