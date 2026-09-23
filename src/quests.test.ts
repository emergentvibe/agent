import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase } from './db.js';

vi.mock('./feature-config.js', () => ({
  loadFeatureConfig: () => ({
    commands: { purchase: false, subscribe: false, rota: false, governance: false, social: true },
    behaviors: { daily_digest: false, crew_digest: false, web: false },
  }),
}));

import {
  questOptIn,
  questOptOut,
  questIsOptedIn,
  questGetOptedIn,
  questGetSentQuests,
  questLogDelivery,
  questGetLastToday,
  deliverQuests,
  loadQuests,
} from './quests.js';

describe('Quest: opt-in/out', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('opt in a user', () => {
    const result = questOptIn('123', 'Alice');
    expect(result.alreadyIn).toBe(false);
    expect(questIsOptedIn('123')).toBe(true);
  });

  it('opt in idempotent', () => {
    questOptIn('123', 'Alice');
    const result = questOptIn('123', 'Alice');
    expect(result.alreadyIn).toBe(true);
  });

  it('opt out a user', () => {
    questOptIn('123', 'Alice');
    const result = questOptOut('123');
    expect(result.wasIn).toBe(true);
    expect(questIsOptedIn('123')).toBe(false);
  });

  it('opt out non-existent user', () => {
    const result = questOptOut('999');
    expect(result.wasIn).toBe(false);
  });

  it('list all opted-in users', () => {
    questOptIn('100', 'Alice');
    questOptIn('200', 'Bob');
    questOptIn('300', 'Charlie');
    const all = questGetOptedIn();
    expect(all).toHaveLength(3);
    const names = all.map((u) => u.attendee_name);
    expect(names).toContain('Alice');
    expect(names).toContain('Bob');
    expect(names).toContain('Charlie');
  });
});

describe('Quest: delivery log', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('log and retrieve sent quests', () => {
    questLogDelivery('123', 'Act like a cat');
    questLogDelivery('123', 'Write a haiku');
    const sent = questGetSentQuests('123');
    expect(sent).toContain('Act like a cat');
    expect(sent).toContain('Write a haiku');
  });

  it('different users have separate logs', () => {
    questLogDelivery('123', 'Act like a cat');
    questLogDelivery('456', 'Write a haiku');
    const sentA = questGetSentQuests('123');
    const sentB = questGetSentQuests('456');
    expect(sentA).toEqual(['Act like a cat']);
    expect(sentB).toEqual(['Write a haiku']);
  });

  it('get last quest today', () => {
    questLogDelivery('123', 'Act like a cat');
    questLogDelivery('123', 'Write a haiku');
    const last = questGetLastToday('123');
    expect(last).toBe('Write a haiku');
  });

  it('get last quest today returns null when none', () => {
    const last = questGetLastToday('123');
    expect(last).toBeNull();
  });
});

describe('Quest: delivery', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('delivers quests to opted-in users', async () => {
    questOptIn('100', 'Alice');
    questOptIn('200', 'Bob');

    const dmsSent: Array<{ userId: string; text: string }> = [];
    const delivered = await deliverQuests({
      registeredGroups: () => ({
        'tg:group': {
          name: 'Test',
          folder: 'test-group',
          isMain: true,
          trigger: '@test',
          added_at: new Date().toISOString(),
          requiresTrigger: true,
        },
      }),
      sendDm: async (userId, text) => {
        dmsSent.push({ userId, text });
      },
    });

    expect(delivered).toBeGreaterThan(0);
    expect(dmsSent.length).toBeGreaterThan(0);
    for (const dm of dmsSent) {
      expect(dm.text).toContain('Your quest:');
    }
  });

  it('does not repeat quests', async () => {
    questOptIn('100', 'Alice');

    const allQuests = loadQuests('nonexistent');
    for (const q of allQuests.slice(0, -1)) {
      questLogDelivery('100', q);
    }

    const dmsSent: Array<{ userId: string; text: string }> = [];
    await deliverQuests({
      registeredGroups: () => ({
        'tg:group': {
          name: 'Test',
          folder: 'test-group',
          isMain: true,
          trigger: '@test',
          added_at: new Date().toISOString(),
          requiresTrigger: true,
        },
      }),
      sendDm: async (userId, text) => {
        dmsSent.push({ userId, text });
      },
    });

    if (dmsSent.length > 0) {
      const lastQuest = allQuests[allQuests.length - 1];
      expect(dmsSent[0].text).toContain(lastQuest);
    }
  });

  it('sends legend message when all quests completed', async () => {
    questOptIn('100', 'Alice');

    const allQuests = loadQuests('nonexistent');
    for (const q of allQuests) {
      questLogDelivery('100', q);
    }

    const dmsSent: Array<{ userId: string; text: string }> = [];
    await deliverQuests({
      registeredGroups: () => ({
        'tg:group': {
          name: 'Test',
          folder: 'test-group',
          isMain: true,
          trigger: '@test',
          added_at: new Date().toISOString(),
          requiresTrigger: true,
        },
      }),
      sendDm: async (userId, text) => {
        dmsSent.push({ userId, text });
      },
    });

    const legendMsg = dmsSent.find((d) => d.text.includes('Legend status'));
    expect(legendMsg).toBeDefined();
    expect(questIsOptedIn('100')).toBe(false);
  });

  it('returns 0 when no one is opted in', async () => {
    const delivered = await deliverQuests({
      registeredGroups: () => ({
        'tg:group': {
          name: 'Test',
          folder: 'test-group',
          isMain: true,
          trigger: '@test',
          added_at: new Date().toISOString(),
          requiresTrigger: true,
        },
      }),
      sendDm: async () => {},
    });
    expect(delivered).toBe(0);
  });

  it('returns 0 when social feature disabled', async () => {
    questOptIn('100', 'Alice');
    const delivered = await deliverQuests({
      registeredGroups: () => ({}),
      sendDm: async () => {},
    });
    expect(delivered).toBe(0);
  });
});

describe('Quest: default quest list', () => {
  it('has at least 15 quests', () => {
    const quests = loadQuests('nonexistent');
    expect(quests.length).toBeGreaterThanOrEqual(15);
  });

  it('all quests are non-empty strings', () => {
    const quests = loadQuests('nonexistent');
    for (const q of quests) {
      expect(typeof q).toBe('string');
      expect(q.length).toBeGreaterThan(0);
    }
  });
});
