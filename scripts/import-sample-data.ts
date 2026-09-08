/**
 * Import sample attendee + rota data into the running bot's SQLite database.
 * Uses the same adapter and import functions as production.
 *
 * Usage: npx tsx scripts/import-sample-data.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Bootstrap the database (same path as the bot)
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const EXCHANGE_DIR = '/private/tmp/treeweek-exchange';
const ATTENDEE_PATH = path.join(EXCHANGE_DIR, 'attendees.sample.json');
const ROTA_PATH = path.join(EXCHANGE_DIR, 'rota.sample.json');

async function main() {
  // Dynamic imports after env setup
  const { initDatabase } = await import('../src/db.js');
  const { attendeeImport, attendeeCount } = await import(
    '../src/attendee-db.js'
  );
  const { rotaImport, rotaGetAllAssignments, rotaReset } = await import(
    '../src/rota-db.js'
  );
  const { adaptAttendeeExport, adaptRotaExport } = await import(
    '../src/sheet-adapter.js'
  );

  initDatabase();

  // --- Attendees ---
  console.log('Reading attendees from', ATTENDEE_PATH);
  const attendeeRaw = JSON.parse(fs.readFileSync(ATTENDEE_PATH, 'utf-8'));
  const attendeePayload = adaptAttendeeExport(
    attendeeRaw.people,
    attendeeRaw.generated_at,
    attendeeRaw.event,
  );
  const attendeeResult = attendeeImport(attendeePayload);
  console.log(
    `Attendees: ${attendeeResult.created} created, ${attendeeResult.updated} updated (${attendeeResult.total} total)`,
  );
  const counts = attendeeCount();
  console.log(
    `  → ${counts.total} in DB (${counts.organizers} organizers, ${counts.crew} crew+org)`,
  );

  // --- Rota ---
  console.log('\nReading rota from', ROTA_PATH);
  const rotaRaw = JSON.parse(fs.readFileSync(ROTA_PATH, 'utf-8'));
  const rotaPayload = adaptRotaExport(rotaRaw, { allowTest: true });

  // Reset existing rota before import
  rotaReset();
  const rotaResult = rotaImport(rotaPayload);
  console.log(
    `Rota: ${rotaResult.inserted} assignments imported (version: ${rotaPayload.version})`,
  );
  const allAssignments = rotaGetAllAssignments();
  const days = new Set(allAssignments.map((a) => a.day));
  console.log(`  → ${allAssignments.length} in DB across ${days.size} days`);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
