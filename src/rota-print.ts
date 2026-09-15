import PDFDocument from 'pdfkit';

import { attendeeGetAll, type AttendeeRecord } from './attendee-db.js';
import {
  rotaGetAllAssignments,
  rotaGetAllNoShifts,
  rotaGetByDate,
  rotaGetMeta,
  type RotaAssignment,
} from './rota-db.js';

interface BlockGroup {
  label: string;
  start: string;
  end: string;
  assignments: RotaAssignment[];
}

function groupByBlock(assignments: RotaAssignment[]): BlockGroup[] {
  const map = new Map<string, BlockGroup>();
  for (const a of assignments) {
    const key = `${a.start}-${a.end}-${a.block_label}`;
    if (!map.has(key)) {
      map.set(key, {
        label: a.block_label,
        start: a.start,
        end: a.end,
        assignments: [],
      });
    }
    map.get(key)!.assignments.push(a);
  }
  return Array.from(map.values());
}

function buildAttendeeMap(): Map<string, AttendeeRecord> {
  const map = new Map<string, AttendeeRecord>();
  for (const a of attendeeGetAll()) {
    if (a.name) map.set(a.name.toLowerCase(), a);
    if (a.telegram_handle) map.set(a.telegram_handle.toLowerCase(), a);
  }
  return map;
}

function resolveDisplayIdentity(
  a: RotaAssignment,
  attendeeMap: Map<string, AttendeeRecord>,
): string {
  const name = a.original_name || '???';

  if (a.state === 'open') return `${name} — COVER NEEDED`;

  // Look up attendee for contact info
  let attendee: AttendeeRecord | undefined;
  if (a.original_telegram) {
    attendee = attendeeMap.get(a.original_telegram.toLowerCase());
  }
  if (!attendee && a.original_name) {
    attendee = attendeeMap.get(a.original_name.toLowerCase());
  }

  // Build identity: name + contact identifier
  // @handle if available, else (telegram display name) to make it clear who's who
  let contact = '';
  if (a.original_telegram && a.original_telegram.startsWith('@')) {
    contact = a.original_telegram;
  } else if (attendee?.telegram_display) {
    contact = `(${attendee.telegram_display})`;
  }

  let line = contact ? `${name} ${contact}` : name;

  if (a.state === 'covered') {
    const covererName = a.current_name || '???';
    let covererContact = '';
    if (a.current_telegram && a.current_telegram.startsWith('@')) {
      covererContact = a.current_telegram;
    }
    const coverer = covererContact
      ? `${covererName} ${covererContact}`
      : covererName;
    line = `${line} → ${coverer.toUpperCase()} covering`;
  }

  return line;
}

function resolveShortIdentifier(
  a: RotaAssignment,
  attendeeMap: Map<string, AttendeeRecord>,
): string {
  if (a.original_telegram && a.original_telegram.startsWith('@')) {
    return a.original_telegram;
  }
  let attendee: AttendeeRecord | undefined;
  if (a.original_telegram) {
    attendee = attendeeMap.get(a.original_telegram.toLowerCase());
  }
  if (!attendee && a.original_name) {
    attendee = attendeeMap.get(a.original_name.toLowerCase());
  }
  if (attendee?.telegram_handle) {
    const h = attendee.telegram_handle;
    return h.startsWith('@') ? h : `@${h}`;
  }
  if (attendee?.telegram_display) {
    return `(${attendee.telegram_display})`;
  }
  return '';
}

function formatDateHeader(date: string, day?: number): string {
  const d = new Date(date + 'T12:00:00');
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const dateStr = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
  const dayLabel = day ? `  ·  Day ${day}` : '';
  return `${weekday} ${dateStr}${dayLabel}`;
}

function formatShortDate(date: string): string {
  const d = new Date(date + 'T12:00:00');
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const dateStr = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
  return `${weekday}\n${dateStr}`;
}

// ─── Daily PDF ──────────────────────────────────────────────

export async function generateRotaPdf(
  date: string,
): Promise<{ buffer: Buffer; filename: string } | { error: string }> {
  const meta = rotaGetMeta();
  if (!meta) {
    return { error: 'No rota loaded yet.' };
  }

  const assignments = rotaGetByDate(date);
  if (assignments.length === 0) {
    return { error: `No shifts scheduled for ${date}.` };
  }

  const attendeeMap = buildAttendeeMap();
  const day = assignments[0]?.day;
  const blocks = groupByBlock(assignments);
  const openCount = assignments.filter((a) => a.state === 'open').length;
  const asOf = new Date().toLocaleString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    timeZone: meta.timezone || undefined,
  });

  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: {
      Title: `Kitchen Shifts — ${date}`,
      Author: 'Treeweek Rota Bot',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const PAGE_WIDTH = doc.page.width - 80;

  doc.fontSize(18).font('Helvetica-Bold');
  doc.text(formatDateHeader(date, day), { width: PAGE_WIDTH });

  doc
    .fontSize(9)
    .font('Helvetica')
    .text(`as of ${asOf}`, { align: 'right', width: PAGE_WIDTH });

  doc.moveDown(0.3);
  doc
    .moveTo(40, doc.y)
    .lineTo(40 + PAGE_WIDTH, doc.y)
    .lineWidth(1.5)
    .stroke();
  doc.moveDown(0.5);

  for (const block of blocks) {
    doc.fontSize(13).font('Helvetica-Bold');
    doc.text(`${block.start}–${block.end}  ${block.label}`, {
      width: PAGE_WIDTH,
    });
    doc.moveDown(0.2);

    for (const a of block.assignments) {
      const line = resolveDisplayIdentity(a, attendeeMap);
      doc.fontSize(11).font('Helvetica');

      if (a.state === 'open') {
        doc.font('Helvetica-Bold').text(`    ${line}`, { width: PAGE_WIDTH });
      } else if (a.state === 'covered') {
        doc
          .font('Helvetica-Oblique')
          .text(`    ${line}`, { width: PAGE_WIDTH });
      } else {
        doc.text(`    ${line}`, { width: PAGE_WIDTH });
      }
    }
    doc.moveDown(0.6);
  }

  if (openCount > 0) {
    doc
      .moveDown(0.3)
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(
        `${openCount} open slot${openCount > 1 ? 's' : ''} — DM the bot: /cover`,
        { width: PAGE_WIDTH },
      );
  }

  doc.moveDown(1.5);
  doc
    .moveTo(40, doc.y)
    .lineTo(40 + PAGE_WIDTH, doc.y)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.5);

  doc
    .fontSize(9)
    .font('Helvetica')
    .text(
      "Can't make a shift? DM the bot: /cover — you're still on it until someone claims it.",
      { width: PAGE_WIDTH },
    );

  doc.moveDown(1);

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const filename = `shifts-${date}.pdf`;
      resolve({ buffer, filename });
    });
  });
}

// ─── Weekly PDF (landscape grid) ────────────────────────────

const FAIRNESS_LINES = [
  'Everyone does roughly 1.2 hours a day, adjusted for how many days you are here.',
  'You never work two shifts in one day, and never the same job more than twice all week.',
  'Party-night shifts count double, and the morning after counts one and a half.',
  'Work a party-night dish shift and the next day is yours, guaranteed.',
  'Arrival day is on crew and volunteers, because most of you are on a train.',
];

export async function generateWeeklyRotaPdf(): Promise<
  { buffer: Buffer; filename: string } | { error: string }
> {
  const meta = rotaGetMeta();
  if (!meta) {
    return { error: 'No rota loaded yet.' };
  }

  const all = rotaGetAllAssignments();
  if (all.length === 0) {
    return { error: 'No shifts in rota.' };
  }

  const dates = [...new Set(all.map((a) => a.date))].sort();
  const asOf = new Date().toLocaleString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
    timeZone: meta.timezone || undefined,
  });

  // Collect block slots in order of appearance (same label can have different times)
  const blockOrder: string[] = [];
  const blockMeta = new Map<
    string,
    { label: string; start: string; end: string }
  >();
  for (const a of all) {
    const key = `${a.start}-${a.end}-${a.block_label}`;
    if (!blockOrder.includes(key)) {
      blockOrder.push(key);
      blockMeta.set(key, {
        label: a.block_label,
        start: a.start,
        end: a.end,
      });
    }
  }

  // Build grid data: blockKey → date → names
  const grid = new Map<string, Map<string, string[]>>();
  for (const key of blockOrder) {
    grid.set(key, new Map());
  }
  const attendeeMap = buildAttendeeMap();
  for (const a of all) {
    const key = `${a.start}-${a.end}-${a.block_label}`;
    const dateMap = grid.get(key)!;
    if (!dateMap.has(a.date)) dateMap.set(a.date, []);
    const name = a.original_name || '???';
    if (a.state === 'open') {
      dateMap.get(a.date)!.push('(open)');
    } else {
      const displayName = a.state === 'covered' ? (a.current_name || name) : name;
      const identifier = resolveShortIdentifier(a, attendeeMap);
      dateMap.get(a.date)!.push(identifier ? `${displayName} ${identifier}` : displayName);
    }
  }

  // Hall of Fame: crew with fixed roles
  const noShifts = rotaGetAllNoShifts();
  const allAttendees = attendeeGetAll();
  const crewWithTitles: Array<{ name: string; title: string }> = [];

  // From attendees with role crew/organizer and a title
  for (const att of allAttendees) {
    if ((att.role === 'crew' || att.role === 'organizer') && att.title) {
      crewWithTitles.push({ name: att.name, title: att.title });
    }
  }

  // From no_shifts table (people with fixed roles who aren't in the rota)
  for (const ns of noShifts) {
    if (!crewWithTitles.some((c) => c.name === ns.name) && ns.reason) {
      crewWithTitles.push({ name: ns.name, title: ns.reason });
    }
  }

  // --- Layout ---
  const MARGIN = 30;
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: MARGIN,
    info: {
      Title: 'Kitchen Shifts — Full Week',
      Author: 'Treeweek Rota Bot',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const PAGE_W = doc.page.width - MARGIN * 2;
  const PAGE_H = doc.page.height - MARGIN * 2;

  // Title
  doc.fontSize(16).font('Helvetica-Bold');
  doc.text('Kitchen Shifts — Full Week', MARGIN, MARGIN, { width: PAGE_W });
  doc.fontSize(8).font('Helvetica');
  doc.text(`as of ${asOf}`, MARGIN, MARGIN + 2, {
    width: PAGE_W,
    align: 'right',
  });

  const gridTop = MARGIN + 28;
  doc
    .moveTo(MARGIN, gridTop)
    .lineTo(MARGIN + PAGE_W, gridTop)
    .lineWidth(1.5)
    .stroke();

  // Grid dimensions
  const LABEL_COL_W = 80;
  const dayCount = dates.length;
  const DAY_COL_W = (PAGE_W - LABEL_COL_W) / dayCount;
  const HEADER_H = 28;
  const blockCount = blockOrder.length;
  const availableH = PAGE_H - (gridTop - MARGIN) - HEADER_H - 120; // reserve space for HoF + footer
  const ROW_H = Math.min(availableH / blockCount, 80);

  // Day headers
  const headerY = gridTop + 4;
  doc.fontSize(8).font('Helvetica-Bold');
  for (let i = 0; i < dayCount; i++) {
    const x = MARGIN + LABEL_COL_W + i * DAY_COL_W;
    doc.text(formatShortDate(dates[i]), x + 3, headerY, {
      width: DAY_COL_W - 6,
      align: 'center',
    });
  }

  const tableTop = gridTop + HEADER_H;

  // Header row bottom line
  doc
    .moveTo(MARGIN, tableTop)
    .lineTo(MARGIN + PAGE_W, tableTop)
    .lineWidth(0.75)
    .stroke();

  // Grid rows
  for (let r = 0; r < blockCount; r++) {
    const key = blockOrder[r];
    const meta2 = blockMeta.get(key)!;
    const rowY = tableTop + r * ROW_H;

    // Block label cell
    doc.fontSize(7).font('Helvetica-Bold');
    doc.text(`${meta2.start}–${meta2.end}`, MARGIN + 2, rowY + 3, {
      width: LABEL_COL_W - 4,
    });
    doc.fontSize(8).font('Helvetica-Bold');
    doc.text(meta2.label, MARGIN + 2, rowY + 13, {
      width: LABEL_COL_W - 4,
    });

    // Day cells
    const dateMap = grid.get(key)!;
    for (let c = 0; c < dayCount; c++) {
      const x = MARGIN + LABEL_COL_W + c * DAY_COL_W;
      const names = dateMap.get(dates[c]) || [];
      doc.fontSize(7).font('Helvetica');
      const cellText = names.join('\n');
      doc.text(cellText, x + 3, rowY + 3, {
        width: DAY_COL_W - 6,
        height: ROW_H - 6,
        lineGap: 1,
      });

      // Vertical column line
      doc
        .moveTo(x, tableTop)
        .lineTo(x, tableTop + blockCount * ROW_H)
        .lineWidth(0.25)
        .stroke();
    }

    // Row bottom line
    const lineY = rowY + ROW_H;
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(MARGIN + PAGE_W, lineY)
      .lineWidth(r === blockCount - 1 ? 0.75 : 0.25)
      .stroke();
  }

  // Label column left line
  doc
    .moveTo(MARGIN + LABEL_COL_W, gridTop)
    .lineTo(MARGIN + LABEL_COL_W, tableTop + blockCount * ROW_H)
    .lineWidth(0.5)
    .stroke();

  // Right edge
  doc
    .moveTo(MARGIN + PAGE_W, gridTop)
    .lineTo(MARGIN + PAGE_W, tableTop + blockCount * ROW_H)
    .lineWidth(0.5)
    .stroke();

  // Left edge
  doc
    .moveTo(MARGIN, gridTop)
    .lineTo(MARGIN, tableTop + blockCount * ROW_H)
    .lineWidth(0.5)
    .stroke();

  // --- Hall of Fame ---
  let hofY = tableTop + blockCount * ROW_H + 10;

  if (crewWithTitles.length > 0) {
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Hall of Fame', MARGIN, hofY, { width: PAGE_W });
    hofY += 13;

    doc.fontSize(7).font('Helvetica');
    const hofLines = crewWithTitles.map((c) => `${c.name} — ${c.title}`);
    // Lay out in columns (3 across)
    const COL_COUNT = 3;
    const COL_W = PAGE_W / COL_COUNT;
    for (let i = 0; i < hofLines.length; i++) {
      const col = i % COL_COUNT;
      const row = Math.floor(i / COL_COUNT);
      doc.text(hofLines[i], MARGIN + col * COL_W, hofY + row * 10, {
        width: COL_W - 8,
      });
    }
    const hofRows = Math.ceil(hofLines.length / COL_COUNT);
    hofY += hofRows * 10 + 6;
  }

  // --- Fairness explainer ---
  doc.fontSize(7).font('Helvetica-Oblique');
  for (const line of FAIRNESS_LINES) {
    doc.text(line, MARGIN, hofY, { width: PAGE_W });
    hofY += 9;
  }

  // --- Footer ---
  hofY += 4;
  doc
    .moveTo(MARGIN, hofY)
    .lineTo(MARGIN + PAGE_W, hofY)
    .lineWidth(0.5)
    .stroke();
  hofY += 5;
  doc.fontSize(7).font('Helvetica');
  doc.text(
    "Can't make a shift? DM the bot: /cover — you're still on it until someone claims it.",
    MARGIN,
    hofY,
    { width: PAGE_W },
  );

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const filename = `shifts-week-${dates[0]}-to-${dates[dates.length - 1]}.pdf`;
      resolve({ buffer, filename });
    });
  });
}

export function parsePrintArgs(text: string): string {
  const args = text.trim().split(/\s+/).slice(1);
  const today =
    process.env.DATE_OVERRIDE || new Date().toISOString().slice(0, 10);
  if (args.length === 0 || args[0] === 'tomorrow') {
    const tomorrow = new Date(today + 'T12:00:00');
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().slice(0, 10);
  }
  if (args[0] === 'today') {
    return today;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
    return args[0];
  }
  return today;
}
