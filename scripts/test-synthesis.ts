import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const SYNTHESIS_MODEL = 'claude-haiku-4-5-20251001';

const baseSchedule = {
  dayName: 'Tue 22 Sep',
  dayNumber: 1,
  events: [
    { time: '09:00', name: 'Breakfast' },
    { time: '09:30', name: 'Team meeting' },
    { time: '13:00', name: 'Lunch' },
    { time: '14:00', name: 'Arrival + settle in' },
    { time: '18:00', name: 'Dinner' },
    { time: '19:00', name: 'Opening speech' },
    { time: '20:00', name: 'PARTY' },
  ],
};

// Real Mem0 data from the sim run (post-patch)
const updates = [
  'Morning yoga at 7am in the Garden on Tue 15 Sep',
  'Co-working from 10am in the Barn on Tue 15 Sep',
  'Community dinner at 7pm in the main house on Tue 15 Sep',
  'Permaculture workshop at 3pm in the garden on Tue 15 Sep with River covering composting basics, soil health assessment, and how to start a seed library. Bring gloves if you have them, it\'s hands-on.',
  'Game of tag proposed outside by the big oak tree on Tue 15 Sep in approximately one hour (proposed by Sam)',
  'Dinner moved from 7pm to 6:30pm on Tue 15 Sep (updated by Jordan)',
  'Morning yoga is cancelled on Wed 16 Sep. The instructor is taking a rest day.',
  'Community bonfire at 9pm at the fire pit by the lake on Wed 16 Sep',
  'Sauna closing early on Tue 15 Sep at 8pm instead of 10pm due to heating system maintenance',
  'Movie night at 9pm in the barn on Wed 16 Sep. Attendees will vote on what to watch over dinner.',
  'Dinner moved from 6:30pm to 6pm on Tue 15 Sep. Kitchen crew starting early for big feast.',
  'Co-working moved from the Barn to the Library on Tue 15 Sep due to a leak.',
];

const prompt = `Merge a community event schedule with live updates from group chat.

## Base schedule for ${baseSchedule.dayName} (Day ${baseSchedule.dayNumber})
${JSON.stringify(baseSchedule.events)}

## Updates from chat
${updates.map((u, i) => `${i + 1}. ${u}`).join('\n')}

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

async function main() {
  const client = new Anthropic();
  console.log('Testing synthesis prompt with Haiku...\n');
  console.log(`Input: ${baseSchedule.events.length} base events + ${updates.length} updates\n`);

  const start = Date.now();
  const response = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const latency = Date.now() - start;

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    console.error('No text in response');
    process.exit(1);
  }

  console.log(`Latency: ${latency}ms`);
  console.log(`Tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`);
  console.log(`Cost: $${((response.usage.input_tokens * 0.8 + response.usage.output_tokens * 4) / 1_000_000).toFixed(5)}\n`);

  const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('No JSON in response:', textBlock.text);
    process.exit(1);
  }

  const events = JSON.parse(jsonMatch[0]);
  console.log('=== SYNTHESIZED SCHEDULE ===\n');

  for (const e of events) {
    const status = e.status === 'on' ? '  ' :
                   e.status === 'changed' ? '⚡' :
                   e.status === 'cancelled' ? '✕ ' :
                   e.status === 'new' ? '✦ ' : '??';
    const change = e.change ? ` ← ${e.change}` : '';
    const loc = e.location ? ` · ${e.location}` : '';
    const note = e.note ? ` (${e.note})` : '';
    const src = e.source ? ` [${e.source}]` : '';
    const name = e.status === 'cancelled' ? `\x1b[9m${e.name}\x1b[0m` : e.name;
    console.log(`  ${status} ${e.time}  ${name}${loc}${note}${change}${src}`);
  }

  console.log(`\n${events.length} events total`);
  console.log(`  on: ${events.filter((e: any) => e.status === 'on').length}`);
  console.log(`  changed: ${events.filter((e: any) => e.status === 'changed').length}`);
  console.log(`  cancelled: ${events.filter((e: any) => e.status === 'cancelled').length}`);
  console.log(`  new: ${events.filter((e: any) => e.status === 'new').length}`);
}

main().catch(console.error);
