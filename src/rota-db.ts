import type Database from 'better-sqlite3';

import { _getDb } from './db.js';
import { logger } from './logger.js';

// --- Types ---

export interface RotaBlock {
  key: string;
  label: string;
  start: string;
  end: string;
  hours: number;
  slots: number;
}

export interface RotaAssignment {
  id: string;
  day: number;
  date: string;
  block: string;
  block_label: string;
  slot: number;
  start: string;
  end: string;
  hours: number;
  weight: number;
  original_person: string | null;
  original_name: string | null;
  original_telegram: string | null;
  original_telegram_id: string | null;
  current_person: string | null;
  current_name: string | null;
  current_telegram: string | null;
  state: 'assigned' | 'open' | 'covered';
  note: string | null;
}

export interface RotaLogEntry {
  id: number;
  ts: string;
  assignment_id: string;
  from_person: string | null;
  to_person: string | null;
  reason: string;
}

export interface RotaMeta {
  version: string;
  timezone: string;
  imported_at: string;
}

export interface RotaNoShiftEntry {
  person_id: string;
  name: string;
  reason: string;
}

export interface RotaImportPayload {
  is_test?: boolean;
  force?: boolean;
  version: string;
  timezone: string;
  blocks: RotaBlock[];
  big_nights: number[];
  no_shifts?: RotaNoShiftEntry[];
  assignments: Array<{
    id: string;
    day: number;
    date: string;
    block: string;
    block_label: string;
    slot: number;
    start: string;
    end: string;
    hours: number;
    weight: number;
    rota_key: string | null;
    name: string | null;
    telegram: string | null;
    telegram_id?: string | null;
  }>;
}

// --- Schema ---

export function createRotaSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS rota_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rota_blocks (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      start TEXT NOT NULL,
      "end" TEXT NOT NULL,
      hours REAL NOT NULL,
      slots INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rota_assignments (
      id TEXT PRIMARY KEY,
      day INTEGER NOT NULL,
      date TEXT NOT NULL,
      block TEXT NOT NULL,
      block_label TEXT NOT NULL,
      slot INTEGER NOT NULL,
      start TEXT NOT NULL,
      "end" TEXT NOT NULL,
      hours REAL NOT NULL,
      weight REAL NOT NULL,
      original_person TEXT,
      original_name TEXT,
      original_telegram TEXT,
      original_telegram_id TEXT,
      current_person TEXT,
      current_name TEXT,
      current_telegram TEXT,
      state TEXT NOT NULL DEFAULT 'assigned',
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rota_day ON rota_assignments(day);
    CREATE INDEX IF NOT EXISTS idx_rota_date ON rota_assignments(date);
    CREATE INDEX IF NOT EXISTS idx_rota_state ON rota_assignments(state);
    CREATE INDEX IF NOT EXISTS idx_rota_current_person ON rota_assignments(current_person);
    CREATE INDEX IF NOT EXISTS idx_rota_telegram_id ON rota_assignments(original_telegram_id);
    CREATE INDEX IF NOT EXISTS idx_rota_telegram ON rota_assignments(original_telegram);

    CREATE TABLE IF NOT EXISTS rota_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      from_person TEXT,
      to_person TEXT,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rota_no_shifts (
      person_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rota_notifications (
      assignment_id TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (assignment_id, notification_type)
    );
  `);
}

// --- Helpers ---

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function intervalsOverlap(
  s1: string,
  e1: string,
  s2: string,
  e2: string,
): boolean {
  return (
    timeToMinutes(s1) < timeToMinutes(e2) &&
    timeToMinutes(s2) < timeToMinutes(e1)
  );
}

function logMutation(
  db: Database.Database,
  assignmentId: string,
  fromPerson: string | null,
  toPerson: string | null,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO rota_log (ts, assignment_id, from_person, to_person, reason) VALUES (?, ?, ?, ?, ?)`,
  ).run(new Date().toISOString(), assignmentId, fromPerson, toPerson, reason);
}

// --- Import ---

export function rotaImport(payload: RotaImportPayload): {
  inserted: number;
  replaced: boolean;
} {
  const db = _getDb();

  if (payload.is_test === true) {
    throw new Error(
      'Test rota rejected (is_test=true). Wait for the real run.',
    );
  }
  if (payload.version.startsWith('TEST-')) {
    throw new Error('TEST- prefixed versions are rejected');
  }

  const existing = rotaGetMeta();
  if (existing && existing.version !== payload.version) {
    throw new Error(
      `Version mismatch: imported "${existing.version}", received "${payload.version}". Use /admin-rota-reset first.`,
    );
  }
  const replaced = !!existing;

  // Freeze guard: refuse replacement when covers/releases have happened
  if (replaced && !payload.force) {
    const mutations = db
      .prepare('SELECT COUNT(*) as c FROM rota_log')
      .get() as { c: number };
    if (mutations.c > 0) {
      throw new Error(
        `Rota has ${mutations.c} mutation(s) in the log (covers/releases). Import refused to avoid losing live data. Use force flag to override.`,
      );
    }
  }

  const ids = new Set<string>();
  for (const a of payload.assignments) {
    if (ids.has(a.id)) {
      throw new Error(`Duplicate assignment ID: ${a.id}`);
    }
    ids.add(a.id);
  }

  const blockKeys = new Set(payload.blocks.map((b) => b.key));
  for (const a of payload.assignments) {
    if (!blockKeys.has(a.block)) {
      throw new Error(
        `Assignment ${a.id} references unknown block: ${a.block}`,
      );
    }
  }

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM rota_assignments').run();
    db.prepare('DELETE FROM rota_blocks').run();
    db.prepare('DELETE FROM rota_log').run();
    db.prepare('DELETE FROM rota_notifications').run();
    db.prepare('DELETE FROM rota_no_shifts').run();

    db.prepare('DELETE FROM rota_meta').run();
    db.prepare('INSERT INTO rota_meta (key, value) VALUES (?, ?)').run(
      'version',
      payload.version,
    );
    db.prepare('INSERT INTO rota_meta (key, value) VALUES (?, ?)').run(
      'timezone',
      payload.timezone,
    );
    db.prepare('INSERT INTO rota_meta (key, value) VALUES (?, ?)').run(
      'imported_at',
      new Date().toISOString(),
    );
    db.prepare('INSERT INTO rota_meta (key, value) VALUES (?, ?)').run(
      'big_nights',
      JSON.stringify(payload.big_nights),
    );

    const insertBlock = db.prepare(
      `INSERT INTO rota_blocks (key, label, start, "end", hours, slots) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const b of payload.blocks) {
      insertBlock.run(b.key, b.label, b.start, b.end, b.hours, b.slots);
    }

    const insertAssignment = db.prepare(
      `INSERT INTO rota_assignments (id, day, date, block, block_label, slot, start, "end", hours, weight,
        original_person, original_name, original_telegram, original_telegram_id,
        current_person, current_name, current_telegram, state, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const a of payload.assignments) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
        throw new Error(`Invalid date format: ${a.date} (expected yyyy-MM-dd)`);
      }
      const filled = a.rota_key !== null;
      const telegram =
        a.telegram && a.telegram !== '(no telegram)' ? a.telegram : null;
      insertAssignment.run(
        a.id,
        a.day,
        a.date,
        a.block,
        a.block_label,
        a.slot,
        a.start,
        a.end,
        a.hours,
        a.weight,
        filled ? a.rota_key : null,
        filled ? a.name : null,
        filled ? telegram : null,
        a.telegram_id ?? null,
        filled ? a.rota_key : null,
        filled ? a.name : null,
        filled ? telegram : null,
        filled ? 'assigned' : 'open',
        null,
      );
    }

    if (payload.no_shifts && payload.no_shifts.length > 0) {
      const insertNoShift = db.prepare(
        'INSERT INTO rota_no_shifts (person_id, name, reason) VALUES (?, ?, ?)',
      );
      for (const ns of payload.no_shifts) {
        insertNoShift.run(ns.person_id, ns.name, ns.reason);
      }
    }
  });

  txn();

  logger.info(
    `Rota imported: ${payload.assignments.length} assignments, ${payload.no_shifts?.length || 0} no-shift entries, version=${payload.version}, replaced=${replaced}`,
  );
  return { inserted: payload.assignments.length, replaced };
}

// --- Queries ---

export function rotaGetMeta(): RotaMeta | undefined {
  const db = _getDb();
  const rows = db.prepare('SELECT key, value FROM rota_meta').all() as Array<{
    key: string;
    value: string;
  }>;
  if (rows.length === 0) return undefined;

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    version: map['version'],
    timezone: map['timezone'],
    imported_at: map['imported_at'],
  };
}

export function rotaGetByDate(date: string): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare(
      'SELECT * FROM rota_assignments WHERE date = ? ORDER BY start, slot',
    )
    .all(date) as RotaAssignment[];
}

export function rotaGetByDay(day: number): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare(
      'SELECT * FROM rota_assignments WHERE day = ? ORDER BY start, slot',
    )
    .all(day) as RotaAssignment[];
}

export function rotaGetByTelegramId(telegramId: string): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare(
      `SELECT * FROM rota_assignments WHERE original_telegram_id = ? ORDER BY day, start`,
    )
    .all(telegramId) as RotaAssignment[];
}

export function rotaGetByHandle(handle: string): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare(
      `SELECT * FROM rota_assignments WHERE original_telegram = ? ORDER BY day, start`,
    )
    .all(handle) as RotaAssignment[];
}

export function rotaBindTelegramId(handle: string, telegramId: string): number {
  const db = _getDb();
  const result = db
    .prepare(
      `UPDATE rota_assignments SET original_telegram_id = ? WHERE original_telegram = ?`,
    )
    .run(telegramId, handle);
  if (result.changes > 0) {
    logger.info(
      `Rota: bound ${handle} → telegram_id ${telegramId} (${result.changes} rows)`,
    );
  }
  return result.changes;
}

export function rotaGetByPersonId(personId: string): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare(
      `SELECT * FROM rota_assignments WHERE original_person = ? ORDER BY day, start`,
    )
    .all(personId) as RotaAssignment[];
}

export function rotaBindTelegramIdByPersonId(
  personId: string,
  telegramId: string,
): number {
  const db = _getDb();
  const result = db
    .prepare(
      `UPDATE rota_assignments SET original_telegram_id = ? WHERE original_person = ?`,
    )
    .run(telegramId, personId);
  if (result.changes > 0) {
    logger.info(
      `Rota: bound person_id ${personId} → telegram_id ${telegramId} (${result.changes} rows)`,
    );
  }
  return result.changes;
}

export function rotaGetById(id: string): RotaAssignment | undefined {
  const db = _getDb();
  return db.prepare('SELECT * FROM rota_assignments WHERE id = ?').get(id) as
    | RotaAssignment
    | undefined;
}

export function rotaGetOpenSlots(): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare(
      "SELECT * FROM rota_assignments WHERE state = 'open' ORDER BY day, start",
    )
    .all() as RotaAssignment[];
}

export function rotaGetAllAssignments(): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare('SELECT * FROM rota_assignments ORDER BY day, start, slot')
    .all() as RotaAssignment[];
}

export function rotaGetCoveredByPerson(telegramId: string): RotaAssignment[] {
  const db = _getDb();
  return db
    .prepare(
      `SELECT * FROM rota_assignments WHERE current_person = ? AND state = 'covered' ORDER BY day, start`,
    )
    .all(telegramId) as RotaAssignment[];
}

export function rotaGetNoShiftReason(personId: string): string | null {
  const db = _getDb();
  const row = db
    .prepare('SELECT reason FROM rota_no_shifts WHERE person_id = ?')
    .get(personId) as { reason: string } | undefined;
  return row?.reason ?? null;
}

export function rotaGetNoShiftByName(name: string): RotaNoShiftEntry | null {
  const db = _getDb();
  const row = db
    .prepare('SELECT * FROM rota_no_shifts WHERE LOWER(name) = LOWER(?)')
    .get(name) as RotaNoShiftEntry | undefined;
  return row ?? null;
}

// --- Mutations ---

export function rotaRelease(
  assignmentId: string,
  telegramId: string,
): { ok: true } | { ok: false; reason: string } {
  const db = _getDb();

  const hasOpen = db
    .prepare(
      `SELECT id FROM rota_assignments WHERE original_telegram_id = ? AND state = 'open' LIMIT 1`,
    )
    .get(telegramId) as { id: string } | undefined;

  if (hasOpen) {
    return { ok: false, reason: 'one_open' };
  }

  const result = db
    .prepare(
      `UPDATE rota_assignments SET state = 'open', current_person = NULL, current_name = NULL, current_telegram = NULL
       WHERE id = ? AND state = 'assigned' AND original_telegram_id = ?`,
    )
    .run(assignmentId, telegramId);

  if (result.changes === 0) {
    return { ok: false, reason: 'not_found_or_wrong_state' };
  }

  logMutation(db, assignmentId, telegramId, null, 'cover_request');
  return { ok: true };
}

export function rotaClaim(
  assignmentId: string,
  person: string,
  name: string,
  handle: string | null,
): { ok: true } | { ok: false; reason: string } {
  const db = _getDb();

  const target = db
    .prepare('SELECT * FROM rota_assignments WHERE id = ?')
    .get(assignmentId) as RotaAssignment | undefined;

  if (!target) {
    return { ok: false, reason: 'not_found' };
  }
  if (target.state !== 'open') {
    return { ok: false, reason: 'already_taken' };
  }

  const txn = db.transaction(() => {
    const sameDayAssignments = db
      .prepare(
        `SELECT start, "end" FROM rota_assignments
         WHERE date = ? AND (original_telegram_id = ? OR current_person = ?)
         AND id != ?`,
      )
      .all(target.date, person, person, assignmentId) as Array<{
      start: string;
      end: string;
    }>;

    for (const existing of sameDayAssignments) {
      if (
        intervalsOverlap(target.start, target.end, existing.start, existing.end)
      ) {
        return { ok: false as const, reason: 'overlap' };
      }
    }

    const result = db
      .prepare(
        `UPDATE rota_assignments SET state = 'covered', current_person = ?, current_name = ?, current_telegram = ?
         WHERE id = ? AND state = 'open'`,
      )
      .run(person, name, handle, assignmentId);

    if (result.changes === 0) {
      return { ok: false as const, reason: 'already_taken' };
    }

    logMutation(db, assignmentId, target.original_person, person, 'claimed');
    return { ok: true as const };
  });

  return txn();
}

export function rotaRerelease(
  assignmentId: string,
  telegramId: string,
): { ok: true } | { ok: false; reason: string } {
  const db = _getDb();

  const target = db
    .prepare('SELECT * FROM rota_assignments WHERE id = ?')
    .get(assignmentId) as RotaAssignment | undefined;

  if (!target) {
    return { ok: false, reason: 'not_found' };
  }
  if (target.state !== 'covered' || target.current_person !== telegramId) {
    return { ok: false, reason: 'not_yours' };
  }

  db.prepare(
    `UPDATE rota_assignments SET state = 'open', current_person = NULL, current_name = NULL, current_telegram = NULL
     WHERE id = ? AND state = 'covered'`,
  ).run(assignmentId);

  logMutation(db, assignmentId, telegramId, null, 'rerelease');
  return { ok: true };
}

export function rotaLeaveEarly(telegramId: string): string[] {
  const db = _getDb();
  const now = new Date().toISOString().slice(0, 10);

  const future = db
    .prepare(
      `SELECT id, original_person FROM rota_assignments
       WHERE original_telegram_id = ? AND state = 'assigned' AND date >= ?`,
    )
    .all(telegramId, now) as Array<{ id: string; original_person: string }>;

  const release = db.prepare(
    `UPDATE rota_assignments SET state = 'open', current_person = NULL, current_name = NULL, current_telegram = NULL
     WHERE id = ? AND state = 'assigned'`,
  );

  const releasedIds: string[] = [];
  const txn = db.transaction(() => {
    for (const row of future) {
      const r = release.run(row.id);
      if (r.changes > 0) {
        logMutation(db, row.id, row.original_person, null, 'leave_early');
        releasedIds.push(row.id);
      }
    }
  });
  txn();
  return releasedIds;
}

export function rotaReset(): void {
  const db = _getDb();
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM rota_assignments').run();
    db.prepare('DELETE FROM rota_blocks').run();
    db.prepare('DELETE FROM rota_meta').run();
    db.prepare('DELETE FROM rota_log').run();
    db.prepare('DELETE FROM rota_notifications').run();
    db.prepare('DELETE FROM rota_no_shifts').run();
  });
  txn();
  logger.info('Rota: all tables cleared');
}

// --- Log ---

export function rotaGetLog(): RotaLogEntry[] {
  const db = _getDb();
  return db
    .prepare('SELECT * FROM rota_log ORDER BY ts')
    .all() as RotaLogEntry[];
}

// --- Notifications ---

export function rotaHasPinged(assignmentId: string, type: string): boolean {
  const db = _getDb();
  const row = db
    .prepare(
      'SELECT 1 FROM rota_notifications WHERE assignment_id = ? AND notification_type = ?',
    )
    .get(assignmentId, type);
  return !!row;
}

export function rotaRecordPing(assignmentId: string, type: string): void {
  const db = _getDb();
  db.prepare(
    `INSERT OR IGNORE INTO rota_notifications (assignment_id, notification_type, sent_at)
     VALUES (?, ?, ?)`,
  ).run(assignmentId, type, new Date().toISOString());
}

// --- Board message tracking ---

export function rotaGetBoardMessageId(): number | null {
  const db = _getDb();
  const row = db
    .prepare("SELECT value FROM rota_meta WHERE key = 'board_message_id'")
    .get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

export function rotaSetBoardMessageId(messageId: number): void {
  const db = _getDb();
  db.prepare(
    "INSERT OR REPLACE INTO rota_meta (key, value) VALUES ('board_message_id', ?)",
  ).run(String(messageId));
}

export function rotaClearBoardMessageId(): void {
  const db = _getDb();
  db.prepare("DELETE FROM rota_meta WHERE key = 'board_message_id'").run();
}

// --- State response ---

export function rotaBuildStateResponse(): object | undefined {
  const meta = rotaGetMeta();
  if (!meta) return undefined;

  const assignments = rotaGetAllAssignments();
  const log = rotaGetLog();

  return {
    version: meta.version,
    as_of: new Date().toISOString(),
    assignments: assignments.map((a) => ({
      id: a.id,
      day: a.day,
      date: a.date,
      block: a.block,
      block_label: a.block_label,
      slot: a.slot,
      start: a.start,
      end: a.end,
      hours: a.hours,
      weight: a.weight,
      original_person: a.original_person,
      original_name: a.original_name,
      current_person: a.current_person,
      current_name: a.current_name,
      state: a.state,
      note: a.note,
    })),
    log: log.map((l) => ({
      ts: l.ts,
      assignment_id: l.assignment_id,
      from: l.from_person,
      to: l.to_person,
      reason: l.reason,
    })),
  };
}

// --- Backup export (full dump, reimportable + covers) ---

export function rotaExportBackup(): object | undefined {
  const db = _getDb();
  const meta = rotaGetMeta();
  if (!meta) return undefined;

  const bigNightsRaw = db
    .prepare("SELECT value FROM rota_meta WHERE key = 'big_nights'")
    .get() as { value: string } | undefined;
  const big_nights: number[] = bigNightsRaw
    ? JSON.parse(bigNightsRaw.value)
    : [];

  const blocks = db
    .prepare('SELECT * FROM rota_blocks ORDER BY start')
    .all() as RotaBlock[];

  const assignments = rotaGetAllAssignments();
  const log = rotaGetLog();

  const noShifts = db
    .prepare('SELECT * FROM rota_no_shifts')
    .all() as RotaNoShiftEntry[];

  return {
    exported_at: new Date().toISOString(),
    version: meta.version,
    timezone: meta.timezone,
    blocks,
    big_nights,
    no_shifts: noShifts,
    assignments: assignments.map((a) => ({
      id: a.id,
      day: a.day,
      date: a.date,
      block: a.block,
      block_label: a.block_label,
      slot: a.slot,
      start: a.start,
      end: a.end,
      hours: a.hours,
      weight: a.weight,
      person_id: a.original_person,
      name: a.original_name,
      telegram: a.original_telegram,
      telegram_id: a.original_telegram_id,
      state: a.state,
      current_person_id: a.state === 'covered' ? a.current_person : undefined,
      current_name: a.state === 'covered' ? a.current_name : undefined,
      current_telegram: a.state === 'covered' ? a.current_telegram : undefined,
    })),
    covers: log.map((l) => ({
      ts: l.ts,
      assignment_id: l.assignment_id,
      from_person_id: l.from_person,
      to_person_id: l.to_person,
      reason: l.reason,
    })),
  };
}
