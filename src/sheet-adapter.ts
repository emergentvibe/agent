/**
 * Adapter: converts the sheet agent's export formats into our import contracts.
 *
 * Schema 1.1: the sheet agent now issues assignment_id and slot.
 * We adopt them as canonical rather than synthesising our own.
 */
import type { AttendeeImportPayload } from './attendee-db.js';
import type {
  RotaBlock,
  RotaImportPayload,
  RotaNoShiftEntry,
} from './rota-db.js';

// --- Sheet agent types (incoming, schema 1.1) ---

export interface SheetAttendee {
  person_id: string;
  name: string;
  telegram_username: string | null;
  telegram_display: string | null;
  phone: string | null;
  role: 'organizer' | 'organiser' | 'crew' | 'attendee';
  title: string | null;
  is_admin: boolean;
}

export interface SheetRotaAssignment {
  assignment_id: string;
  slot: number;
  state: 'assigned' | 'open';
  original_person_id: string | null;
  person_id: string | null;
  name: string | null;
  telegram_username: string | null;
  telegram_display: string | null;
  date: string;
  day: number;
  block: string;
  label: string;
  start: string;
  end: string;
  hours: number;
  weight: number;
}

export interface SheetRotaExport {
  export: string;
  schema_version: string;
  generated_at: string;
  is_test: boolean;
  supersedes_all_previous: boolean;
  event: string;
  timezone: string;
  days: Array<{ day: number; date: string }>;
  blocks: RotaBlock[];
  big_nights: Array<{ day: number; date: string; type: string }>;
  weighting: {
    rule: string;
    big_night_multiplier: number;
    morning_after_multiplier: number;
  };
  counts: { assignments: number; people: number; no_shifts: number };
  assignments: SheetRotaAssignment[];
  no_shifts: Array<{ person_id: string; name: string; reason: string }>;
  is_sample?: boolean;
  redactions?: string[];
}

// --- Attendee adapter ---

export function adaptAttendeeExport(
  attendees: SheetAttendee[],
  version: string,
  event: string,
): AttendeeImportPayload {
  return {
    version,
    event,
    attendees: attendees.map((a) => ({
      person_id: a.person_id,
      name: a.name,
      telegram_username: a.telegram_username,
      telegram_display: a.telegram_display,
      phone: a.phone,
      role: a.role === 'organiser' ? 'organizer' : a.role,
      title: a.title,
    })),
  };
}

// --- Rota adapter ---

export function adaptRotaExport(sheet: SheetRotaExport): RotaImportPayload {
  if (sheet.is_test) {
    throw new Error(
      'Refusing test rota (is_test=true). Wait for the real run.',
    );
  }

  const blocks: RotaBlock[] = sheet.blocks.map((b) => ({
    key: b.key,
    label: b.label,
    start: b.start,
    end: b.end,
    hours: b.hours,
    slots: b.slots,
  }));

  const assignments = sheet.assignments.map((a) => {
    const filled = a.state === 'assigned' && a.person_id !== null;
    return {
      id: a.assignment_id,
      day: a.day,
      date: a.date,
      block: a.block,
      block_label: a.label,
      slot: a.slot,
      start: a.start,
      end: a.end,
      hours: a.hours,
      weight: a.weight,
      rota_key: filled ? a.person_id : null,
      name: filled ? a.name : null,
      telegram: filled ? a.telegram_username : null,
      telegram_id: null as string | null,
    };
  });

  const noShifts: RotaNoShiftEntry[] = (sheet.no_shifts || []).map((ns) => ({
    person_id: ns.person_id,
    name: ns.name,
    reason: ns.reason,
  }));

  return {
    is_test: false,
    version: sheet.generated_at,
    timezone: sheet.timezone,
    blocks,
    big_nights: sheet.big_nights.map((bn) => bn.day),
    no_shifts: noShifts,
    assignments,
  };
}

/**
 * Build an attendee lookup map from a sheet attendee array.
 * Keys by person_id for O(1) lookups during rota adaptation.
 */
export function buildAttendeeLookup(
  attendees: SheetAttendee[],
): Map<string, SheetAttendee> {
  return new Map(attendees.map((a) => [a.person_id, a]));
}
