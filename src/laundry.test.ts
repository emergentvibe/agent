import { describe, expect, it, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  cancelLastPurchase,
  getUserTotal,
  storePurchase,
} from './db.js';
import {
  createLoad,
  getActiveLoads,
  joinLoad,
  LAUNDRY_PRICE,
  leaveLoad,
} from './laundry.js';
import { _getDb } from './db.js';

const JID = 'tg:-100test';

beforeEach(() => {
  _initTestDatabase();
});

describe('createLoad', () => {
  it('returns L1 for the first load', () => {
    const result = createLoad(JID, 'user1', 'Alice');
    expect(result.loadId).toBe('L1');
    expect(result.purchaseId).toBeGreaterThan(0);
    expect(getUserTotal('user1')).toBe(LAUNDRY_PRICE);
  });

  it('increments load IDs', () => {
    const first = createLoad(JID, 'user1', 'Alice');
    const second = createLoad(JID, 'user2', 'Bob');
    expect(first.loadId).toBe('L1');
    expect(second.loadId).toBe('L2');
  });
});

describe('joinLoad', () => {
  it('splits 2-way at €2.50 each', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    const result = joinLoad(loadId, JID, 'user2', 'Bob');

    expect(result.success).toBe(true);
    expect(result.memberCount).toBe(2);
    expect(result.shareEach).toBe(2.5);
    expect(result.existingMembers).toEqual([
      { userId: 'user1', userName: 'Alice' },
    ]);

    expect(getUserTotal('user1')).toBe(2.5);
    expect(getUserTotal('user2')).toBe(2.5);
  });

  it('splits 3-way at €1.67 each', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    joinLoad(loadId, JID, 'user2', 'Bob');
    const result = joinLoad(loadId, JID, 'user3', 'Charlie');

    expect(result.success).toBe(true);
    expect(result.memberCount).toBe(3);
    expect(result.shareEach).toBe(1.67);

    expect(getUserTotal('user1')).toBe(1.67);
    expect(getUserTotal('user2')).toBe(1.67);
    expect(getUserTotal('user3')).toBe(1.67);
  });

  it('rejects expired loads', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    const db = _getDb();
    const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE laundry_loads SET created_at = ? WHERE load_id = ?').run(
      pastDate,
      loadId,
    );

    const result = joinLoad(loadId, JID, 'user2', 'Bob');
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('rejects duplicate members', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    const result = joinLoad(loadId, JID, 'user1', 'Alice');
    expect(result.success).toBe(false);
    expect(result.error).toContain('already');
  });

  it('rejects non-existent load', () => {
    const result = joinLoad('L999', JID, 'user1', 'Alice');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('leaveLoad', () => {
  it('cancels a solo load and refunds', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    expect(getUserTotal('user1')).toBe(LAUNDRY_PRICE);

    const result = leaveLoad(loadId, 'user1');
    expect(result.success).toBe(true);
    expect(result.wasLastMember).toBe(true);
    expect(result.refundAmount).toBe(LAUNDRY_PRICE);
    expect(getUserTotal('user1')).toBe(0);

    const db = _getDb();
    const load = db
      .prepare('SELECT * FROM laundry_loads WHERE load_id = ?')
      .get(loadId);
    expect(load).toBeUndefined();
  });

  it('adjusts split when leaving a 2-person load', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    joinLoad(loadId, JID, 'user2', 'Bob');

    expect(getUserTotal('user1')).toBe(2.5);
    expect(getUserTotal('user2')).toBe(2.5);

    const result = leaveLoad(loadId, 'user2');
    expect(result.success).toBe(true);
    expect(result.wasLastMember).toBe(false);
    expect(result.refundAmount).toBe(2.5);
    expect(result.remainingMembers).toEqual([
      { userId: 'user1', userName: 'Alice', newShare: LAUNDRY_PRICE },
    ]);

    expect(getUserTotal('user1')).toBe(LAUNDRY_PRICE);
    expect(getUserTotal('user2')).toBe(0);
  });

  it('adjusts split when leaving a 3-person load', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    joinLoad(loadId, JID, 'user2', 'Bob');
    joinLoad(loadId, JID, 'user3', 'Charlie');

    const result = leaveLoad(loadId, 'user3');
    expect(result.success).toBe(true);
    expect(result.refundAmount).toBe(1.67);
    expect(result.remainingMembers).toHaveLength(2);
    expect(result.remainingMembers[0].newShare).toBe(2.5);

    expect(getUserTotal('user1')).toBe(2.5);
    expect(getUserTotal('user2')).toBe(2.5);
    expect(getUserTotal('user3')).toBe(0);
  });

  it('rejects non-member', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    const result = leaveLoad(loadId, 'user99');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not in');
  });

  it('rejects expired loads', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    const db = _getDb();
    const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE laundry_loads SET created_at = ? WHERE load_id = ?').run(
      pastDate,
      loadId,
    );

    const result = leaveLoad(loadId, 'user1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });
});

describe('getActiveLoads', () => {
  it('returns non-expired loads for a user', () => {
    createLoad(JID, 'user1', 'Alice');
    createLoad(JID, 'user1', 'Alice');

    const loads = getActiveLoads('user1');
    expect(loads).toHaveLength(2);
    expect(loads[0].loadId).toBe('L1');
    expect(loads[1].loadId).toBe('L2');
  });

  it('filters out expired loads', () => {
    createLoad(JID, 'user1', 'Alice');
    const { loadId: expiredId } = createLoad(JID, 'user1', 'Alice');
    const db = _getDb();
    const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE laundry_loads SET created_at = ? WHERE load_id = ?').run(
      pastDate,
      expiredId,
    );

    const loads = getActiveLoads('user1');
    expect(loads).toHaveLength(1);
    expect(loads[0].loadId).toBe('L1');
  });

  it('returns empty for user with no loads', () => {
    expect(getActiveLoads('nobody')).toEqual([]);
  });
});

describe('getUserTotal integration', () => {
  it('tracks correct totals through create, join, and leave', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    expect(getUserTotal('user1')).toBe(5);

    joinLoad(loadId, JID, 'user2', 'Bob');
    expect(getUserTotal('user1')).toBe(2.5);
    expect(getUserTotal('user2')).toBe(2.5);

    leaveLoad(loadId, 'user2');
    expect(getUserTotal('user1')).toBe(5);
    expect(getUserTotal('user2')).toBe(0);

    leaveLoad(loadId, 'user1');
    expect(getUserTotal('user1')).toBe(0);
  });
});

describe('cancelLastPurchase skips laundry', () => {
  it('cancels bar purchase but skips laundry', () => {
    createLoad(JID, 'user1', 'Alice');
    storePurchase(JID, 'user1', 'Alice', 'Beer', 1.5);

    expect(getUserTotal('user1')).toBe(6.5);

    const cancelled = cancelLastPurchase('user1');
    expect(cancelled).not.toBeNull();
    expect(cancelled!.item).toBe('Beer');

    expect(getUserTotal('user1')).toBe(5);
  });
});

describe('transaction safety', () => {
  it('does not leave partial state on cancelled rows if load does not exist for join', () => {
    const { loadId } = createLoad(JID, 'user1', 'Alice');
    const totalBefore = getUserTotal('user1');
    expect(totalBefore).toBe(5);

    const result = joinLoad('NONEXISTENT', JID, 'user2', 'Bob');
    expect(result.success).toBe(false);

    expect(getUserTotal('user1')).toBe(5);
    expect(getUserTotal('user2')).toBe(0);
  });
});
