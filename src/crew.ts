/**
 * Crew member configuration — reads crew.json from the group folder.
 * Crew members get elevated trust on operational matters and receive
 * the evening crew digest.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

export interface CrewMember {
  id: string;
  name: string;
}

export function loadCrewList(groupFolder: string): CrewMember[] {
  const configPath = path.join(resolveGroupFolderPath(groupFolder), 'crew.json');
  if (!fs.existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (Array.isArray(raw)) return raw;
    if (raw.members && Array.isArray(raw.members)) return raw.members;
    return [];
  } catch {
    return [];
  }
}

export function isCrewMember(groupFolder: string, senderId: string): boolean {
  const crew = loadCrewList(groupFolder);
  return crew.some((m) => m.id === senderId);
}
