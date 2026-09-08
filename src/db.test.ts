import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getMessagesBefore,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSession,
  getTaskById,
  isAnyPurchaseTopic,
  isExtractionEnabled,
  isPurchaseTopicForCategory,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setTopicExtraction,
  storeChatMetadata,
  storeMessage,
  updateTask,
  upsertTopic,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });

  it('getMessagesBefore returns N most recent messages before timestamp', () => {
    const messages = getMessagesBefore(
      'group@g.us',
      '2024-01-01T00:00:06.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 4');
    expect(messages[2].content).toBe('message 6');
    expect(messages[0].timestamp < messages[1].timestamp).toBe(true);
  });

  it('getMessagesBefore returns all when fewer than limit exist', () => {
    const messages = getMessagesBefore(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Andy',
      10,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 1');
    expect(messages[2].content).toBe('message 3');
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('purchase topic matching', () => {
  beforeEach(() => {
    upsertTopic('tg:group1', 10, 'Bar');
    upsertTopic('tg:group1', 11, '🍖 BBQ Corner');
    upsertTopic('tg:group1', 12, 'Meat Station');
    upsertTopic('tg:group1', 13, 'General');
    upsertTopic('tg:group1', 14, 'Kitchen Shifts');
  });

  describe('isPurchaseTopicForCategory', () => {
    it('matches "Bar" topic for bar category', () => {
      expect(isPurchaseTopicForCategory(10, 'bar')).toBe(true);
    });

    it('does not match "Bar" topic for bbq category', () => {
      expect(isPurchaseTopicForCategory(10, 'bbq')).toBe(false);
    });

    it('matches "BBQ Corner" topic for bbq category (case-insensitive, emoji)', () => {
      expect(isPurchaseTopicForCategory(11, 'bbq')).toBe(true);
    });

    it('matches "Meat Station" topic for bbq category', () => {
      expect(isPurchaseTopicForCategory(12, 'bbq')).toBe(true);
    });

    it('does not match "Meat Station" for bar category', () => {
      expect(isPurchaseTopicForCategory(12, 'bar')).toBe(false);
    });

    it('does not match unrelated topics', () => {
      expect(isPurchaseTopicForCategory(13, 'bar')).toBe(false);
      expect(isPurchaseTopicForCategory(14, 'bbq')).toBe(false);
    });

    it('returns false for null/undefined thread_id', () => {
      expect(isPurchaseTopicForCategory(null, 'bar')).toBe(false);
      expect(isPurchaseTopicForCategory(undefined, 'bar')).toBe(false);
    });

    it('returns false for unknown thread_id', () => {
      expect(isPurchaseTopicForCategory(999, 'bar')).toBe(false);
    });
  });

  describe('isAnyPurchaseTopic', () => {
    it('returns true for bar topic', () => {
      expect(isAnyPurchaseTopic(10)).toBe(true);
    });

    it('returns true for bbq topic', () => {
      expect(isAnyPurchaseTopic(11)).toBe(true);
    });

    it('returns true for meat topic', () => {
      expect(isAnyPurchaseTopic(12)).toBe(true);
    });

    it('returns false for unrelated topic', () => {
      expect(isAnyPurchaseTopic(13)).toBe(false);
      expect(isAnyPurchaseTopic(14)).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isAnyPurchaseTopic(null)).toBe(false);
      expect(isAnyPurchaseTopic(undefined)).toBe(false);
    });
  });
});

// --- Router state round-trip ---

describe('router state', () => {
  it('round-trips a value', () => {
    setRouterState('cursor', '2026-09-01T00:00:00Z');
    expect(getRouterState('cursor')).toBe('2026-09-01T00:00:00Z');
  });

  it('overwrites an existing key', () => {
    setRouterState('cursor', 'old');
    setRouterState('cursor', 'new');
    expect(getRouterState('cursor')).toBe('new');
  });

  it('returns undefined for missing key', () => {
    expect(getRouterState('nonexistent')).toBeUndefined();
  });

  it('handles JSON values', () => {
    const timestamps = { 'tg:-100': '2026-09-01', 'tg:-200': '2026-09-02' };
    setRouterState('extraction_ts', JSON.stringify(timestamps));
    const retrieved = JSON.parse(getRouterState('extraction_ts')!);
    expect(retrieved).toEqual(timestamps);
  });
});

// --- Session round-trip ---

describe('sessions', () => {
  it('round-trips a session ID', () => {
    setSession('telegram_topic-test', 'sess-abc123');
    expect(getSession('telegram_topic-test')).toBe('sess-abc123');
  });

  it('overwrites session on re-set', () => {
    setSession('telegram_topic-test', 'old-sess');
    setSession('telegram_topic-test', 'new-sess');
    expect(getSession('telegram_topic-test')).toBe('new-sess');
  });

  it('returns undefined for unknown group', () => {
    expect(getSession('nonexistent-group')).toBeUndefined();
  });

  it('getAllSessions returns all stored sessions', () => {
    setSession('group-a', 'sess-1');
    setSession('group-b', 'sess-2');
    setSession('group-c', 'sess-3');
    const all = getAllSessions();
    expect(all).toEqual({
      'group-a': 'sess-1',
      'group-b': 'sess-2',
      'group-c': 'sess-3',
    });
  });

  it('getAllSessions returns empty object when no sessions', () => {
    expect(getAllSessions()).toEqual({});
  });
});

// --- Extraction per-topic gating ---

describe('isExtractionEnabled', () => {
  const chatJid = 'tg:-1001234';

  it('General topic (null thread) is always enabled', () => {
    expect(isExtractionEnabled(chatJid, null)).toBe(true);
    expect(isExtractionEnabled(chatJid, undefined)).toBe(true);
  });

  it('General topic (thread_id 1) is always enabled', () => {
    expect(isExtractionEnabled(chatJid, 1)).toBe(true);
  });

  it('unknown topic defaults to OFF', () => {
    expect(isExtractionEnabled(chatJid, 999)).toBe(false);
  });

  it('new topic defaults to extraction OFF', () => {
    upsertTopic(chatJid, 42, 'Kitchen Chat');
    expect(isExtractionEnabled(chatJid, 42)).toBe(false);
  });

  it('returns true after extraction is toggled ON', () => {
    upsertTopic(chatJid, 50, 'Events');
    expect(isExtractionEnabled(chatJid, 50)).toBe(false);
    setTopicExtraction(chatJid, 50, true);
    expect(isExtractionEnabled(chatJid, 50)).toBe(true);
  });

  it('can toggle extraction back OFF', () => {
    upsertTopic(chatJid, 60, 'Logistics');
    setTopicExtraction(chatJid, 60, true);
    expect(isExtractionEnabled(chatJid, 60)).toBe(true);
    setTopicExtraction(chatJid, 60, false);
    expect(isExtractionEnabled(chatJid, 60)).toBe(false);
  });

  it('different chats have independent gating', () => {
    const other = 'tg:-1005678';
    upsertTopic(chatJid, 70, 'Music');
    upsertTopic(other, 70, 'Music');
    setTopicExtraction(chatJid, 70, true);
    expect(isExtractionEnabled(chatJid, 70)).toBe(true);
    expect(isExtractionEnabled(other, 70)).toBe(false);
  });
});
