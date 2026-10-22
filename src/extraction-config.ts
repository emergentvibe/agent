import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

export interface ExtractionCategory {
  name: string;
  description: string;
  examples: string[];
}

export interface ExtractionConfig {
  categories: ExtractionCategory[];
  exclusions: string[];
  time_context: string;
}

export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  categories: [
    {
      name: 'EVENT/ACTIVITY ANNOUNCEMENTS',
      description: 'workshops, gatherings, scheduled activities',
      examples: [
        '"Workshop at 15:00 in the garden on Thu 25 Sep (announced by Alex)"',
        'Write complete, search-friendly sentences with absolute dates and 24-hour times',
      ],
    },
    {
      name: 'SCHEDULE CHANGES',
      description: 'times, venues, cancellations',
      examples: [
        'When something CHANGES, include what changed: "Dinner moved from 19:00 to 18:30 on Thu 25 Sep (updated by Alex)"',
      ],
    },
    {
      name: 'FACILITY STATUS',
      description: 'infrastructure that affects everyone',
      examples: [
        '"Hot water is out in building B (reported by River)"',
        '"Wifi password changed to oak2026 (announced by Jordan)"',
      ],
    },
    {
      name: 'ACTIVITY PROPOSALS',
      description: 'things people want to organize',
      examples: [
        '"Alex proposed a music jam at 20:00 on Thu 25 Sep in the barn"',
      ],
    },
    {
      name: 'PATTERNS',
      description: 'when 2+ people propose the same activity',
      examples: [
        '"Multiple people (Alex, Priya, River) expressed interest in morning lake swimming"',
      ],
    },
  ],
  exclusions: [
    'Introductions, skills, interests, personal identity (handled by /hello)',
    'Diet, pronouns, health, emotional state, relationships',
    'Greetings, banter, jokes, thanks, emoji reactions',
    'Questions without answers',
    'Social coordination between individuals',
    'Opinions, arguments, complaints about people',
    'Third-party claims about anyone',
    'Anything from the CONTEXT section (already processed)',
  ],
  time_context:
    'Social and cultural events (workshops, jam sessions, movie nights, performances) with a bare single-digit time like "at 9" are almost always evening (21:00) — these rarely happen at 9am.',
};

export function loadExtractionConfig(groupFolder: string): ExtractionConfig {
  const configPath = path.join(
    resolveGroupFolderPath(groupFolder),
    'extraction-config.json',
  );

  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_EXTRACTION_CONFIG);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      categories: raw.categories ?? DEFAULT_EXTRACTION_CONFIG.categories,
      exclusions: raw.exclusions ?? DEFAULT_EXTRACTION_CONFIG.exclusions,
      time_context: raw.time_context ?? DEFAULT_EXTRACTION_CONFIG.time_context,
    };
  } catch {
    return structuredClone(DEFAULT_EXTRACTION_CONFIG);
  }
}
