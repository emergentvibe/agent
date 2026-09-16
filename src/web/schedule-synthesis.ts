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

  const targetDate = `${base.dayName} (Day ${base.dayNumber} of 8)`;

  return `Update a community event schedule for a specific date using community memories.

## Target date: ${targetDate}

## Base schedule
${baseJson}

## Community memories (may or may not be relevant)
${updateLines || '(none)'}

## Rules

**Date filtering (critical):** Only apply memories about ${targetDate}. IGNORE any memory about a different date or day number — do not create events or changes from them. "Day 8", "29 September", etc. are different days.

**Change detection:** A memory is a schedule change ONLY if it says an event was MOVED to a different time, CANCELLED, or a genuinely NEW event was ADDED by someone. Everything else is background context — status stays "on". Examples:
- "dinner moved to 7pm" → changed (explicit time move)
- "yoga cancelled" → cancelled
- "jam session at 4pm in the barn" → new (not in base schedule)
- "people arrive in the afternoon" → NOT a change (arrival already in schedule)
- "lunch includes couscous" → NOT a change (meal details, not a schedule change)
- "Day 1 is Tuesday 22 September" → NOT a change (just a fact)

**Output rules:**
- Start with every base event, status "on"
- Only set "changed"/"cancelled"/"new" when a memory explicitly describes a modification
- "change" field: what changed (e.g. "moved from 7pm", "venue: Barn → Library")
- "note" field: only if genuinely new context (e.g. "bring gloves")
- Do NOT include a "source" field
- When in doubt, leave status as "on"

## Output
JSON array sorted by time. Every base event must appear.
[{"time":"HH:MM","name":"...","status":"on|changed|cancelled|new","note":"...","change":"..."}]

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
