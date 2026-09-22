import type Database from 'better-sqlite3';

import { _getDb, storePurchase } from './db.js';
import { logger } from './logger.js';

export const LAUNDRY_PRICE = 5;
const LOAD_EXPIRY_HOURS = 24;

interface LoadRow {
  load_id: string;
  group_jid: string;
  created_at: string;
}

interface MemberRow {
  load_id: string;
  user_id: string;
  user_name: string;
  purchase_id: number;
  joined_at: string;
}

export function createLaundrySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS laundry_loads (
      load_id TEXT PRIMARY KEY,
      group_jid TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS laundry_members (
      load_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      purchase_id INTEGER,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (load_id, user_id),
      FOREIGN KEY (load_id) REFERENCES laundry_loads(load_id)
    );
  `);
}

function isExpired(createdAt: string): boolean {
  const created = new Date(createdAt).getTime();
  return Date.now() - created > LOAD_EXPIRY_HOURS * 60 * 60 * 1000;
}

function nextLoadId(): string {
  const db = _getDb();
  const row = db
    .prepare(
      'SELECT load_id FROM laundry_loads ORDER BY CAST(SUBSTR(load_id, 2) AS INTEGER) DESC LIMIT 1',
    )
    .get() as { load_id: string } | undefined;

  if (!row) return 'L1';
  const num = parseInt(row.load_id.slice(1), 10);
  return `L${num + 1}`;
}

function cancelPurchaseById(purchaseId: number): void {
  const db = _getDb();
  db.prepare('UPDATE purchases SET cancelled = 1 WHERE id = ?').run(purchaseId);
}

function assertPurchaseId(id: number): void {
  if (id === -1) throw new Error('storePurchase failed');
}

export function createLoad(
  groupJid: string,
  userId: string,
  userName: string,
): { loadId: string; purchaseId: number } {
  const db = _getDb();
  const loadId = nextLoadId();

  const result = db.transaction(() => {
    const purchaseId = storePurchase(
      groupJid,
      userId,
      userName,
      `Laundry ${loadId}`,
      LAUNDRY_PRICE,
    );
    assertPurchaseId(purchaseId);

    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO laundry_loads (load_id, group_jid, created_at) VALUES (?, ?, ?)',
    ).run(loadId, groupJid, now);

    db.prepare(
      'INSERT INTO laundry_members (load_id, user_id, user_name, purchase_id, joined_at) VALUES (?, ?, ?, ?, ?)',
    ).run(loadId, userId, userName, purchaseId, now);

    return { loadId, purchaseId };
  })();

  logger.info({ loadId, userId }, 'Laundry load created');
  return result;
}

export function joinLoad(
  loadId: string,
  groupJid: string,
  userId: string,
  userName: string,
): {
  success: boolean;
  error?: string;
  memberCount: number;
  shareEach: number;
  existingMembers: Array<{ userId: string; userName: string }>;
} {
  const db = _getDb();
  const fail = (error: string) => ({
    success: false,
    error,
    memberCount: 0,
    shareEach: 0,
    existingMembers: [] as Array<{ userId: string; userName: string }>,
  });

  const load = db
    .prepare('SELECT * FROM laundry_loads WHERE load_id = ?')
    .get(loadId) as LoadRow | undefined;

  if (!load) return fail('Load not found.');
  if (isExpired(load.created_at)) return fail('Load has expired (>24h).');

  const existing = db
    .prepare('SELECT * FROM laundry_members WHERE load_id = ? AND user_id = ?')
    .get(loadId, userId);
  if (existing) return fail('You are already in this load.');

  const members = db
    .prepare(
      'SELECT user_id, user_name, purchase_id FROM laundry_members WHERE load_id = ?',
    )
    .all(loadId) as MemberRow[];

  const newCount = members.length + 1;
  const shareEach = Math.round((LAUNDRY_PRICE / newCount) * 100) / 100;

  const existingMembers = members.map((m) => ({
    userId: m.user_id,
    userName: m.user_name,
  }));

  db.transaction(() => {
    for (const member of members) {
      cancelPurchaseById(member.purchase_id);
      const newPurchaseId = storePurchase(
        load.group_jid,
        member.user_id,
        member.user_name,
        `Laundry ${loadId}`,
        shareEach,
      );
      assertPurchaseId(newPurchaseId);
      db.prepare(
        'UPDATE laundry_members SET purchase_id = ? WHERE load_id = ? AND user_id = ?',
      ).run(newPurchaseId, loadId, member.user_id);
    }

    const now = new Date().toISOString();
    const joinerPurchaseId = storePurchase(
      groupJid,
      userId,
      userName,
      `Laundry ${loadId}`,
      shareEach,
    );
    assertPurchaseId(joinerPurchaseId);

    db.prepare(
      'INSERT INTO laundry_members (load_id, user_id, user_name, purchase_id, joined_at) VALUES (?, ?, ?, ?, ?)',
    ).run(loadId, userId, userName, joinerPurchaseId, now);
  })();

  logger.info(
    { loadId, userId, memberCount: newCount, shareEach },
    'Joined laundry load',
  );
  return { success: true, memberCount: newCount, shareEach, existingMembers };
}

export function leaveLoad(
  loadId: string,
  userId: string,
): {
  success: boolean;
  error?: string;
  wasLastMember: boolean;
  refundAmount: number;
  remainingMembers: Array<{
    userId: string;
    userName: string;
    newShare: number;
  }>;
} {
  const db = _getDb();
  const fail = (error: string) => ({
    success: false,
    error,
    wasLastMember: false,
    refundAmount: 0,
    remainingMembers: [] as Array<{
      userId: string;
      userName: string;
      newShare: number;
    }>,
  });

  const load = db
    .prepare('SELECT * FROM laundry_loads WHERE load_id = ?')
    .get(loadId) as LoadRow | undefined;

  if (!load) return fail('Load not found.');
  if (isExpired(load.created_at))
    return fail('Load has expired (>24h). Charges are final.');

  const leaverRow = db
    .prepare('SELECT * FROM laundry_members WHERE load_id = ? AND user_id = ?')
    .get(loadId, userId) as MemberRow | undefined;

  if (!leaverRow) return fail('You are not in this load.');

  const allMembers = db
    .prepare(
      'SELECT user_id, user_name, purchase_id FROM laundry_members WHERE load_id = ?',
    )
    .all(loadId) as MemberRow[];

  const currentShare =
    Math.round((LAUNDRY_PRICE / allMembers.length) * 100) / 100;
  const remaining = allMembers.filter((m) => m.user_id !== userId);

  if (remaining.length === 0) {
    db.transaction(() => {
      cancelPurchaseById(leaverRow.purchase_id);
      db.prepare('DELETE FROM laundry_members WHERE load_id = ?').run(loadId);
      db.prepare('DELETE FROM laundry_loads WHERE load_id = ?').run(loadId);
    })();

    logger.info(
      { loadId, userId },
      'Laundry load cancelled (last member left)',
    );
    return {
      success: true,
      wasLastMember: true,
      refundAmount: currentShare,
      remainingMembers: [],
    };
  }

  const newShare = Math.round((LAUNDRY_PRICE / remaining.length) * 100) / 100;

  const remainingResult: Array<{
    userId: string;
    userName: string;
    newShare: number;
  }> = [];

  db.transaction(() => {
    cancelPurchaseById(leaverRow.purchase_id);
    db.prepare(
      'DELETE FROM laundry_members WHERE load_id = ? AND user_id = ?',
    ).run(loadId, userId);

    for (const member of remaining) {
      cancelPurchaseById(member.purchase_id);
      const newPurchaseId = storePurchase(
        load.group_jid,
        member.user_id,
        member.user_name,
        `Laundry ${loadId}`,
        newShare,
      );
      assertPurchaseId(newPurchaseId);
      db.prepare(
        'UPDATE laundry_members SET purchase_id = ? WHERE load_id = ? AND user_id = ?',
      ).run(newPurchaseId, loadId, member.user_id);
      remainingResult.push({
        userId: member.user_id,
        userName: member.user_name,
        newShare,
      });
    }
  })();

  logger.info(
    { loadId, userId, remainingCount: remaining.length, newShare },
    'Left laundry load',
  );
  return {
    success: true,
    wasLastMember: false,
    refundAmount: currentShare,
    remainingMembers: remainingResult,
  };
}

export function getActiveLoads(userId: string): Array<{
  loadId: string;
  memberCount: number;
  shareEach: number;
}> {
  const db = _getDb();

  const loads = db
    .prepare(
      `SELECT ll.load_id, ll.created_at,
        (SELECT COUNT(*) FROM laundry_members lm2 WHERE lm2.load_id = ll.load_id) as member_count
      FROM laundry_loads ll
      INNER JOIN laundry_members lm ON lm.load_id = ll.load_id AND lm.user_id = ?`,
    )
    .all(userId) as Array<{
    load_id: string;
    created_at: string;
    member_count: number;
  }>;

  return loads
    .filter((l) => !isExpired(l.created_at))
    .map((l) => ({
      loadId: l.load_id,
      memberCount: l.member_count,
      shareEach: Math.round((LAUNDRY_PRICE / l.member_count) * 100) / 100,
    }));
}
