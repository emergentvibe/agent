import fs from 'fs';
import path from 'path';

export interface ScheduleEvent {
  time: string;
  name: string;
  note?: string;
}

export interface DaySchedule {
  date: string;
  dayNumber: number;
  dayName: string;
  events: ScheduleEvent[];
  highlights: string[];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAILY_RHYTHM: ScheduleEvent[] = [
  { time: '09:00', name: 'Breakfast' },
  { time: '09:30', name: 'Team meeting' },
  { time: '13:00', name: 'Lunch' },
  { time: '18:00', name: 'Dinner' },
];

interface DayOverride {
  dayNumber: number;
  extra: ScheduleEvent[];
  highlights: string[];
  replaceRhythm?: boolean;
}

const DAY_OVERRIDES: DayOverride[] = [
  {
    dayNumber: 1,
    extra: [
      { time: '14:00', name: 'Arrival + settle in' },
      { time: '19:00', name: 'Opening speech' },
      { time: '20:00', name: 'PARTY' },
    ],
    highlights: ['Opening speech', 'Party'],
  },
  {
    dayNumber: 2,
    extra: [],
    highlights: [],
  },
  {
    dayNumber: 3,
    extra: [],
    highlights: [],
  },
  {
    dayNumber: 4,
    extra: [
      { time: '14:00', name: 'WHIZBANG', note: 'full house clean' },
      { time: '20:00', name: 'Talent Show' },
    ],
    highlights: ['WHIZBANG', 'Talent Show'],
  },
  {
    dayNumber: 5,
    extra: [
      { time: '12:00', name: 'Mini cleanup' },
      { time: '14:00', name: 'Tree planting', note: 'possible' },
    ],
    highlights: ['Tree planting'],
  },
  {
    dayNumber: 6,
    extra: [{ time: '20:00', name: 'Birthday Party' }],
    highlights: ['Birthday Party'],
  },
  {
    dayNumber: 7,
    extra: [{ time: '14:00', name: 'WHIZBANG', note: 'full house clean' }],
    highlights: ['WHIZBANG', "Simon's birthday"],
  },
  {
    dayNumber: 8,
    extra: [
      { time: '08:00', name: 'Wake up' },
      { time: '09:00', name: 'Breakfast' },
      { time: '10:00', name: 'Bus departs' },
    ],
    highlights: ['Departure day'],
    replaceRhythm: true,
  },
];

const EVENT_START = '2025-09-22';

function getEventStartDate(): Date {
  const eventsPath = path.resolve(
    process.cwd(),
    'knowledge/treeweek/events.md',
  );
  if (fs.existsSync(eventsPath)) {
    const content = fs.readFileSync(eventsPath, 'utf-8');
    const dateMatch = content.match(
      /(?:Tuesday|Monday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\s+September/,
    );
    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const year =
        new Date().getFullYear() >= 2026 ? new Date().getFullYear() : 2025;
      return new Date(year, 8, day);
    }
  }
  return new Date(EVENT_START);
}

export function getFullWeekSchedule(): DaySchedule[] {
  const start = getEventStartDate();
  const days: DaySchedule[] = [];

  for (let i = 0; i < 8; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = localDateStr(d);
    const dayNumber = i + 1;
    const override = DAY_OVERRIDES.find((o) => o.dayNumber === dayNumber);

    let events: ScheduleEvent[];
    if (override?.replaceRhythm) {
      events = [...override.extra];
    } else {
      events = [...DAILY_RHYTHM, ...(override?.extra || [])];
    }
    events.sort((a, b) => a.time.localeCompare(b.time));

    const dayOfWeek = d.getDay();
    const dayName = `${DAY_NAMES[dayOfWeek]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;

    days.push({
      date: dateStr,
      dayNumber,
      dayName,
      events,
      highlights: override?.highlights || [],
    });
  }

  return days;
}

export function getTodaySchedule(today: string): DaySchedule | undefined {
  const week = getFullWeekSchedule();
  return week.find((d) => d.date === today);
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}
