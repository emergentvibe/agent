import type Database from 'better-sqlite3';

import { _getDb } from './db.js';
import { logger } from './logger.js';

// --- Types ---

export interface AttendeeRecord {
  id: number;
  person_id: string | null;
  name: string;
  telegram_handle: string | null;
  telegram_display: string | null;
  telegram_id: string | null;
  phone: string | null;
  role: 'attendee' | 'crew' | 'organizer';
  title: string | null;
  arrival: string | null;
  departure: string | null;
  checked_in: boolean;
  checked_in_at: string | null;
}

export interface AttendeeImportPayload {
  version: string;
  event: string;
  dates?: { start: string; end: string };
  attendees: Array<{
    person_id?: string | null;
    name: string;
    telegram?: string | null;
    telegram_handle?: string | null;
    telegram_username?: string | null;
    telegram_display?: string | null;
    phone?: string | null;
    role?: 'attendee' | 'crew' | 'organizer' | 'organiser';
    title?: string | null;
    arrival?: string | null;
    departure?: string | null;
  }>;
}

// --- Schema ---

export function createAttendeeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT,
      name TEXT NOT NULL UNIQUE,
      telegram_handle TEXT,
      telegram_display TEXT,
      telegram_id TEXT,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'attendee',
      title TEXT,
      arrival TEXT,
      departure TEXT,
      checked_in INTEGER DEFAULT 0,
      checked_in_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attendees_handle ON attendees(telegram_handle);
    CREATE INDEX IF NOT EXISTS idx_attendees_tg_id ON attendees(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_attendees_phone ON attendees(phone);
    CREATE INDEX IF NOT EXISTS idx_attendees_person_id ON attendees(person_id);
  `);

  // Migrations: add columns if missing (existing DBs)
  const migrations = [
    'ALTER TABLE attendees ADD COLUMN telegram_display TEXT',
    'ALTER TABLE attendees ADD COLUMN person_id TEXT',
    'ALTER TABLE attendees ADD COLUMN title TEXT',
  ];
  for (const sql of migrations) {
    try {
      database.exec(sql);
    } catch {
      // Column already exists
    }
  }
}

// --- Import ---

export function attendeeImport(payload: AttendeeImportPayload): {
  total: number;
  created: number;
  updated: number;
} {
  const db = _getDb();

  const upsert = db.prepare(`
    INSERT INTO attendees (person_id, name, telegram_handle, telegram_display, phone, role, title, arrival, departure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      person_id = COALESCE(excluded.person_id, attendees.person_id),
      telegram_handle = COALESCE(excluded.telegram_handle, attendees.telegram_handle),
      telegram_display = COALESCE(excluded.telegram_display, attendees.telegram_display),
      phone = COALESCE(excluded.phone, attendees.phone),
      role = excluded.role,
      title = COALESCE(excluded.title, attendees.title),
      arrival = COALESCE(excluded.arrival, attendees.arrival),
      departure = COALESCE(excluded.departure, attendees.departure)
  `);

  let created = 0;
  let updated = 0;

  const run = db.transaction(() => {
    for (const a of payload.attendees) {
      if (!a.name || typeof a.name !== 'string') continue;

      // Accept `telegram_username`, `telegram_handle`, and `telegram` (legacy)
      const rawHandle = a.telegram_handle || a.telegram_username || a.telegram;
      const handle = rawHandle && rawHandle.trim() ? rawHandle.trim() : null;
      const display =
        a.telegram_display && a.telegram_display.trim()
          ? a.telegram_display.trim()
          : null;
      const phone = a.phone && a.phone.trim() ? a.phone.trim() : null;
      // Normalize British spelling: organiser → organizer
      const rawRole = a.role === 'organiser' ? 'organizer' : a.role;
      const role: 'attendee' | 'crew' | 'organizer' = rawRole || 'attendee';
      const personId = a.person_id || null;
      const title = a.title && a.title.trim() ? a.title.trim() : null;

      const existing = db
        .prepare('SELECT id FROM attendees WHERE name = ?')
        .get(a.name) as { id: number } | undefined;

      upsert.run(
        personId,
        a.name,
        handle,
        display,
        phone,
        role,
        title,
        a.arrival || null,
        a.departure || null,
      );

      if (existing) {
        updated++;
      } else {
        created++;
      }
    }
  });

  run();

  logger.info(
    { total: payload.attendees.length, created, updated },
    'Attendee import complete',
  );

  return { total: payload.attendees.length, created, updated };
}

// --- Lookup ---

export function attendeeLookupByPersonId(
  personId: string,
): AttendeeRecord | null {
  const db = _getDb();
  const row = db
    .prepare('SELECT * FROM attendees WHERE person_id = ?')
    .get(personId) as
    | (Omit<AttendeeRecord, 'checked_in'> & { checked_in: number })
    | undefined;
  return row ? { ...row, checked_in: !!row.checked_in } : null;
}

export function attendeeLookupByTelegramId(
  telegramId: string,
): AttendeeRecord | null {
  const db = _getDb();
  const row = db
    .prepare('SELECT * FROM attendees WHERE telegram_id = ?')
    .get(telegramId) as
    | (Omit<AttendeeRecord, 'checked_in'> & { checked_in: number })
    | undefined;
  return row ? { ...row, checked_in: !!row.checked_in } : null;
}

export function attendeeLookupByHandle(handle: string): AttendeeRecord | null {
  const db = _getDb();
  const normalized = handle.startsWith('@') ? handle : `@${handle}`;
  const row = db
    .prepare('SELECT * FROM attendees WHERE LOWER(telegram_handle) = LOWER(?)')
    .get(normalized) as
    | (Omit<AttendeeRecord, 'checked_in'> & { checked_in: number })
    | undefined;
  return row ? { ...row, checked_in: !!row.checked_in } : null;
}

export function attendeeLookupByTelegramDisplay(
  displayName: string,
): AttendeeRecord | null {
  const db = _getDb();
  // Normalize unicode (variation selectors etc.) and lowercase
  const name = displayName.trim().normalize('NFC').toLowerCase();
  if (!name) return null;
  // Only return a match if exactly one attendee has this display name
  const rows = db
    .prepare('SELECT * FROM attendees WHERE LOWER(telegram_display) = ?')
    .all(name) as Array<
    Omit<AttendeeRecord, 'checked_in'> & { checked_in: number }
  >;
  if (rows.length !== 1) return null;
  return { ...rows[0], checked_in: !!rows[0].checked_in };
}

export function attendeeLookupByName(displayName: string): AttendeeRecord[] {
  const db = _getDb();
  const name = displayName.trim().toLowerCase();
  const rows = db
    .prepare('SELECT * FROM attendees WHERE LOWER(name) = ?')
    .all(name) as Array<
    Omit<AttendeeRecord, 'checked_in'> & { checked_in: number }
  >;

  if (rows.length > 0)
    return rows.map((r) => ({ ...r, checked_in: !!r.checked_in }));

  // Fuzzy: first name match (first word of attendee name matches first word of display name)
  const firstName = name.split(/\s+/)[0];
  if (!firstName) return [];

  const fuzzy = db
    .prepare("SELECT * FROM attendees WHERE LOWER(name) LIKE ? || '%'")
    .all(firstName) as Array<
    Omit<AttendeeRecord, 'checked_in'> & { checked_in: number }
  >;
  return fuzzy.map((r) => ({ ...r, checked_in: !!r.checked_in }));
}

export function attendeeLookupByPhone(phone: string): AttendeeRecord | null {
  const db = _getDb();
  const row = db
    .prepare('SELECT * FROM attendees WHERE phone = ?')
    .get(phone) as
    | (Omit<AttendeeRecord, 'checked_in'> & { checked_in: number })
    | undefined;
  return row ? { ...row, checked_in: !!row.checked_in } : null;
}

// --- Check-in ---

export function attendeeCheckIn(attendeeId: number, telegramId: string): void {
  const db = _getDb();
  db.prepare(
    `UPDATE attendees SET
      telegram_id = ?,
      checked_in = 1,
      checked_in_at = ?
    WHERE id = ?`,
  ).run(telegramId, new Date().toISOString(), attendeeId);

  logger.info({ attendeeId, telegramId }, 'Attendee checked in');
}

// --- Queries ---

export function attendeeGetAll(): AttendeeRecord[] {
  const db = _getDb();
  const rows = db
    .prepare('SELECT * FROM attendees ORDER BY name')
    .all() as Array<
    Omit<AttendeeRecord, 'checked_in'> & { checked_in: number }
  >;
  return rows.map((r) => ({ ...r, checked_in: !!r.checked_in }));
}

export function attendeeGetCheckedIn(): AttendeeRecord[] {
  const db = _getDb();
  const rows = db
    .prepare(
      'SELECT * FROM attendees WHERE checked_in = 1 ORDER BY checked_in_at',
    )
    .all() as Array<
    Omit<AttendeeRecord, 'checked_in'> & { checked_in: number }
  >;
  return rows.map((r) => ({ ...r, checked_in: !!r.checked_in }));
}

export function attendeeGetNotCheckedIn(): AttendeeRecord[] {
  const db = _getDb();
  const rows = db
    .prepare('SELECT * FROM attendees WHERE checked_in = 0 ORDER BY name')
    .all() as Array<
    Omit<AttendeeRecord, 'checked_in'> & { checked_in: number }
  >;
  return rows.map((r) => ({ ...r, checked_in: !!r.checked_in }));
}

export function attendeeGetByRole(
  role: 'attendee' | 'crew' | 'organizer',
): AttendeeRecord[] {
  const db = _getDb();
  const rows = db
    .prepare('SELECT * FROM attendees WHERE role = ? ORDER BY name')
    .all(role) as Array<
    Omit<AttendeeRecord, 'checked_in'> & { checked_in: number }
  >;
  return rows.map((r) => ({ ...r, checked_in: !!r.checked_in }));
}

export function attendeeCount(): {
  total: number;
  checked_in: number;
  crew: number;
  organizers: number;
} {
  const db = _getDb();
  const total = (
    db.prepare('SELECT COUNT(*) as c FROM attendees').get() as { c: number }
  ).c;
  const checked_in = (
    db
      .prepare('SELECT COUNT(*) as c FROM attendees WHERE checked_in = 1')
      .get() as { c: number }
  ).c;
  const crew = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM attendees WHERE role IN ('crew', 'organizer')",
      )
      .get() as { c: number }
  ).c;
  const organizers = (
    db
      .prepare("SELECT COUNT(*) as c FROM attendees WHERE role = 'organizer'")
      .get() as { c: number }
  ).c;

  return { total, checked_in, crew, organizers };
}

export function attendeeClear(): void {
  const db = _getDb();
  db.prepare('DELETE FROM attendees').run();
}

export function isAttendeeAdmin(telegramId: string): boolean {
  const db = _getDb();
  const row = db
    .prepare(
      "SELECT id FROM attendees WHERE telegram_id = ? AND role = 'organizer'",
    )
    .get(telegramId) as { id: number } | undefined;
  return !!row;
}
