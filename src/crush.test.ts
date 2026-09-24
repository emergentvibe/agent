import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, _getDb } from './db.js';
import { attendeeImport } from './attendee-db.js';
import { attendeeFuzzySearch } from './attendee-db.js';
import {
  crushStore,
  crushRemove,
  crushCheckMutual,
  crushGetLeaderboard,
  setCrushPending,
  hasCrushPending,
  clearCrushPending,
} from './crush.js';

const SAMPLE_ATTENDEES = {
  version: '1.0',
  event: 'test',
  attendees: [
    {
      name: 'Alice',
      person_id: 'p1',
      telegram_handle: '@alice',
      telegram_display: 'Alice',
    },
    {
      name: 'Bob',
      person_id: 'p2',
      telegram_handle: '@bob',
      telegram_display: 'Bob',
    },
    {
      name: 'Alexander',
      person_id: 'p3',
      telegram_handle: '@alex',
      telegram_display: 'Alex',
    },
    {
      name: 'Alexandra',
      person_id: 'p4',
      telegram_handle: '@alexandra',
      telegram_display: 'Alexandra',
    },
    {
      name: 'Charlie',
      person_id: 'p5',
      telegram_handle: '@charlie',
      telegram_display: 'Charlie',
    },
  ],
};

function bindTelegramIds() {
  const db = _getDb();
  db.prepare('UPDATE attendees SET telegram_id = ? WHERE name = ?').run(
    '100',
    'Alice',
  );
  db.prepare('UPDATE attendees SET telegram_id = ? WHERE name = ?').run(
    '200',
    'Bob',
  );
  db.prepare('UPDATE attendees SET telegram_id = ? WHERE name = ?').run(
    '300',
    'Alexander',
  );
  db.prepare('UPDATE attendees SET telegram_id = ? WHERE name = ?').run(
    '400',
    'Alexandra',
  );
  db.prepare('UPDATE attendees SET telegram_id = ? WHERE name = ?').run(
    '500',
    'Charlie',
  );
}

describe('Crush: fuzzy search', () => {
  beforeEach(() => {
    _initTestDatabase();
    attendeeImport(SAMPLE_ATTENDEES);
  });

  it('exact match returns single result', () => {
    const results = attendeeFuzzySearch('Alice');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Alice');
  });

  it('case-insensitive match', () => {
    const results = attendeeFuzzySearch('alice');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Alice');
  });

  it('first-name prefix matches multiple', () => {
    const results = attendeeFuzzySearch('Alex');
    expect(results.length).toBeGreaterThanOrEqual(2);
    const names = results.map((r) => r.name);
    expect(names).toContain('Alexander');
    expect(names).toContain('Alexandra');
  });

  it('substring match', () => {
    const results = attendeeFuzzySearch('lic');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('Alice');
  });

  it('no match returns empty', () => {
    const results = attendeeFuzzySearch('Zzzxyz');
    expect(results).toHaveLength(0);
  });

  it('empty query returns empty', () => {
    const results = attendeeFuzzySearch('');
    expect(results).toHaveLength(0);
  });

  it('returns at most 4 results', () => {
    const results = attendeeFuzzySearch('a');
    expect(results.length).toBeLessThanOrEqual(4);
  });
});

describe('Crush: store and mutual detection', () => {
  beforeEach(() => {
    _initTestDatabase();
    attendeeImport(SAMPLE_ATTENDEES);
    bindTelegramIds();
  });

  it('stores a crush', () => {
    const result = crushStore('100', 'Alice', 2, 'Bob');
    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
  });

  it('rejects duplicate crush', () => {
    crushStore('100', 'Alice', 2, 'Bob');
    const result = crushStore('100', 'Alice', 2, 'Bob');
    expect(result.ok).toBe(false);
    expect(result.duplicate).toBe(true);
  });

  it('allows multiple different crushes from same person', () => {
    const r1 = crushStore('100', 'Alice', 2, 'Bob');
    const r2 = crushStore('100', 'Alice', 3, 'Alexander');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('detects mutual crush', () => {
    crushStore('100', 'Alice', 2, 'Bob');
    crushStore('200', 'Bob', 1, 'Alice');
    const mutual = crushCheckMutual('200', 1);
    expect(mutual.mutual).toBe(true);
    expect(mutual.otherTelegramId).toBe('100');
  });

  it('no mutual when only one-sided', () => {
    crushStore('100', 'Alice', 2, 'Bob');
    const mutual = crushCheckMutual('100', 2);
    expect(mutual.mutual).toBe(false);
  });

  it('removes most recent crush only', () => {
    crushStore('100', 'Alice', 2, 'Bob');
    crushStore('100', 'Alice', 3, 'Alexander');
    const result = crushRemove('100');
    expect(result.removed).toBe(true);
    expect(result.crusheeName).toBe('Alexander');
    const lb = crushGetLeaderboard();
    expect(lb.totalCrushes).toBe(1);
    expect(lb.leaderboard[0].name).toBe('Bob');
  });

  it('crushRemove returns false when no crushes', () => {
    const result = crushRemove('999');
    expect(result.removed).toBe(false);
    expect(result.crusheeName).toBeNull();
  });

  it('no mutual when crushee has no telegram_id', () => {
    const db = _getDb();
    db.prepare('UPDATE attendees SET telegram_id = NULL WHERE name = ?').run(
      'Bob',
    );
    crushStore('100', 'Alice', 2, 'Bob');
    const mutual = crushCheckMutual('100', 2);
    expect(mutual.mutual).toBe(false);
  });
});

describe('Crush: leaderboard', () => {
  beforeEach(() => {
    _initTestDatabase();
    attendeeImport(SAMPLE_ATTENDEES);
    bindTelegramIds();
  });

  it('empty when no crushes', () => {
    const lb = crushGetLeaderboard();
    expect(lb.totalCrushes).toBe(0);
    expect(lb.mutualMatches).toBe(0);
    expect(lb.leaderboard).toHaveLength(0);
  });

  it('counts total crushes', () => {
    crushStore('100', 'Alice', 2, 'Bob');
    crushStore('300', 'Alexander', 2, 'Bob');
    crushStore('500', 'Charlie', 1, 'Alice');
    const lb = crushGetLeaderboard();
    expect(lb.totalCrushes).toBe(3);
  });

  it('ranks by crush count descending', () => {
    crushStore('100', 'Alice', 2, 'Bob');
    crushStore('300', 'Alexander', 2, 'Bob');
    crushStore('500', 'Charlie', 1, 'Alice');
    const lb = crushGetLeaderboard();
    expect(lb.leaderboard[0].name).toBe('Bob');
    expect(lb.leaderboard[0].count).toBe(2);
    expect(lb.leaderboard[1].name).toBe('Alice');
    expect(lb.leaderboard[1].count).toBe(1);
  });

  it('counts mutual matches', () => {
    crushStore('100', 'Alice', 2, 'Bob');
    crushStore('200', 'Bob', 1, 'Alice');
    const lb = crushGetLeaderboard();
    expect(lb.mutualMatches).toBe(1);
  });
});

describe('Crush: pending state', () => {
  it('set/has/clear cycle', () => {
    const chatId = 'tg:123';
    expect(hasCrushPending(chatId)).toBe(false);
    setCrushPending(chatId);
    expect(hasCrushPending(chatId)).toBe(true);
    clearCrushPending(chatId);
    expect(hasCrushPending(chatId)).toBe(false);
  });
});
