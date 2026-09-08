import PDFDocument from 'pdfkit';

import { rotaGetByDate, rotaGetMeta, type RotaAssignment } from './rota-db.js';

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

function formatPersonLine(a: RotaAssignment): string {
  if (a.state === 'open' && a.original_name) {
    return `${a.original_name} — cover requested`;
  }
  if (a.state === 'open') {
    return 'OPEN';
  }
  if (a.state === 'covered') {
    const orig = a.original_name || '???';
    const coverer = a.current_name || '???';
    return `${orig} → ${coverer} covering`;
  }
  return a.current_name || a.original_name || '???';
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
      const line = formatPersonLine(a);
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

  // Handwriting box
  const boxX = 40 + PAGE_WIDTH - 200;
  const boxY = doc.y;
  doc.rect(boxX, boxY, 200, 60).lineWidth(0.5).stroke();
  doc
    .fontSize(8)
    .font('Helvetica-Oblique')
    .text('swapped? write it here', boxX + 5, boxY + 5, { width: 190 });

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const filename = `shifts-${date}.pdf`;
      resolve({ buffer, filename });
    });
  });
}

export function parsePrintArgs(text: string): string {
  const args = text.trim().split(/\s+/).slice(1);
  if (args.length === 0 || args[0] === 'tomorrow') {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().slice(0, 10);
  }
  if (args[0] === 'today') {
    return new Date().toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
    return args[0];
  }
  return new Date().toISOString().slice(0, 10);
}
