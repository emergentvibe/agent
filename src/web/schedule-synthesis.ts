import Anthropic from '@anthropic-ai/sdk';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { getToday } from '../config.js';
import { getTodaySchedule, type DaySchedule } from './schedule.js';
import { getCachedUpdates, type ScheduleUpdate } from './schedule-refresh.js';

const SYNTHESIS_MODEL = 'claude-haiku-4-5-20251001';
const SYNTHESIS_MAX_TOKENS = 1024;

export interface SynthesizedEvent {
  time: string;
  name: string;
  status: 'on' | 'changed' | 'cancelled' | 'new';
  location?: string;
  note?: string;
  change?: string;
  source?: string;
}

export interface SynthesizedSchedule {
  date: string;
  dayNumber: number;
  dayName: string;
  highlights: string[];
  events: SynthesizedEvent[];
  synthesizedAt: number;
}

let cachedSynthesis: SynthesizedSchedule | null = null;
let lastInputHash = '';
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const envConfig = readEnvFile(['ANTHROPIC_API_KEY']);
    const apiKey = process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for synthesis');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export function _setClient(mock: Anthropic | null): void {
  client = mock;
}

function hashInputs(base: DaySchedule, updates: ScheduleUpdate[]): string {
  const key =
    base.date +
    base.events.map((e) => e.time + e.name).join('|') +
    updates.map((u) => u.memory).join('|');
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return String(h);
}

export function buildSynthesisPrompt(
  base: DaySchedule,
  updates: ScheduleUpdate[],
): string {
  const baseJson = JSON.stringify(
    base.events.map((e) => ({
      time: e.time,
      name: e.name,
      note: e.note || undefined,
    })),
  );

  const updateLines = updates
    .map((u, i) => {
      const src = u.source ? ` (${u.source})` : '';
      return `${i + 1}. ${u.memory}${src}`;
    })
    .join('\n');

  return `Merge a community event schedule with live updates from group chat.

## Base schedule for ${base.dayName} (Day ${base.dayNumber})
${baseJson}

## Updates from chat
${updateLines || '(none)'}

## Rules
- Start with every base event (status "on")
- Apply updates: time changes → "changed", cancellations → "cancelled"
- Add events from updates not in the base → "new"
- For conflicting updates to the same event, use the latest/most specific
- Cancelled events: keep in list at original time, status "cancelled"
- "change" field: brief summary like "moved from 7pm" or "venue: Barn → Library"
- "source" field: who announced it (from the update text)
- "location" field: only if mentioned
- "note" field: only if there's extra context (e.g. "bring gloves", "hands-on")

## Output
JSON array sorted by time. Every event from the base schedule must appear.
[{"time":"HH:MM","name":"...","status":"on|changed|cancelled|new","location":"...","note":"...","change":"...","source":"..."}]

Return ONLY the JSON array.`;
}

export async function synthesize(
  base: DaySchedule,
  updates: ScheduleUpdate[],
): Promise<SynthesizedEvent[]> {
  const anthropic = getClient();
  const prompt = buildSynthesisPrompt(base, updates);

  const response = await anthropic.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: SYNTHESIS_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Synthesis returned no text');
  }

  const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Synthesis returned no JSON array');
  }

  const parsed = JSON.parse(jsonMatch[0]) as SynthesizedEvent[];
  if (!Array.isArray(parsed)) {
    throw new Error('Synthesis result is not an array');
  }

  return parsed;
}

export function getSynthesizedSchedule(): SynthesizedSchedule | null {
  return cachedSynthesis;
}

export async function refreshSynthesis(): Promise<void> {
  const today = getToday();
  const base = getTodaySchedule(today);
  if (!base) return;

  const updates = getCachedUpdates();
  const hash = hashInputs(base, updates);

  if (hash === lastInputHash && cachedSynthesis) {
    return;
  }

  if (updates.length === 0) {
    cachedSynthesis = {
      date: base.date,
      dayNumber: base.dayNumber,
      dayName: base.dayName,
      highlights: base.highlights,
      events: base.events.map((e) => ({
        time: e.time,
        name: e.name,
        status: 'on' as const,
        note: e.note,
      })),
      synthesizedAt: Date.now(),
    };
    lastInputHash = hash;
    return;
  }

  try {
    const events = await synthesize(base, updates);
    cachedSynthesis = {
      date: base.date,
      dayNumber: base.dayNumber,
      dayName: base.dayName,
      highlights: base.highlights,
      events,
      synthesizedAt: Date.now(),
    };
    lastInputHash = hash;
    logger.info(
      { eventCount: events.length, updateCount: updates.length },
      'Schedule synthesis complete',
    );
  } catch (err) {
    logger.error({ err }, 'Schedule synthesis failed — using raw schedule');
  }
}
