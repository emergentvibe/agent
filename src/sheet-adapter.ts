/**
 * Adapter: converts the sheet agent's export formats into our import contracts.
 *
 * The sheet agent exports rota.json and attendees.json in its own schema.
 * This module transforms them into RotaImportPayload and AttendeeImportPayload
 * so the existing import functions work unchanged.
 */
import type { AttendeeImportPayload } from './attendee-db.js';
import type {
  RotaBlock,
  RotaImportPayload,
  RotaNoShiftEntry,
} from './rota-db.js';

// --- Sheet agent types (incoming) ---

export interface SheetAttendee {
  person_id: string;
  name: string;
  telegram_username: string | null;
  telegram_display: string | null;
  phone: string | null;
  role: 'organiser' | 'crew' | 'attendee';
  title: string | null;
  is_admin: boolean;
}

export interface SheetRotaBlock {
  key: string;
  label: string;
  start: string;
  end: string;
  hours: number;
  slots: number;
}

export interface SheetRotaAssignment {
  person_id: string;
  name: string;
  date: string;
  day: number;
  block: string;
  start: string;
  end: string;
  hours: number;
}

export interface SheetRotaExport {
  is_test: boolean;
  supersedes_all_previous: boolean;
  timezone: string;
  blocks: SheetRotaBlock[];
  assignments: SheetRotaAssignment[];
  no_shifts: Array<{ person_id: string; name: string; reason: string }>;
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

export function adaptRotaExport(
  sheet: SheetRotaExport,
  version: string,
  attendeeLookup?: Map<string, SheetAttendee>,
): RotaImportPayload {
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

  const blockMap = new Map(sheet.blocks.map((b) => [b.key, b]));

  // Track slot counts per day+block for auto-numbering
  const slotCounters = new Map<string, number>();

  const assignments = sheet.assignments.map((a) => {
    const counterKey = `${a.date}-${a.block}`;
    const slot = (slotCounters.get(counterKey) || 0) + 1;
    slotCounters.set(counterKey, slot);

    const block = blockMap.get(a.block);
    const blockLabel = block?.label || a.block;

    // Cross-reference attendee for telegram handle
    const attendee = attendeeLookup?.get(a.person_id);
    const telegram = attendee?.telegram_username || null;

    return {
      id: `${a.date}-${a.block}-${slot}`,
      day: a.day,
      date: a.date,
      block: a.block,
      block_label: blockLabel,
      slot,
      start: a.start,
      end: a.end,
      hours: a.hours,
      weight: a.hours,
      rota_key: a.person_id,
      name: a.name,
      telegram,
      telegram_id: null as string | null,
    };
  });

  const noShifts: RotaNoShiftEntry[] = (sheet.no_shifts || []).map((ns) => ({
    person_id: ns.person_id,
    name: ns.name,
    reason: ns.reason,
  }));

  return {
    version,
    timezone: sheet.timezone,
    blocks,
    big_nights: [],
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
