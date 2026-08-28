/**
 * Triage utilities — thin wrapper around trigger pattern matching.
 * Memory extraction logic has moved to extraction.ts.
 */
import { TRIGGER_PATTERN } from './config.js';

export interface TriageMemory {
  text: string;
  user_id: string;
  metadata?: Record<string, string>;
}

export function shouldRespond(messageContent: string): boolean {
  return TRIGGER_PATTERN.test(messageContent.trim());
}
