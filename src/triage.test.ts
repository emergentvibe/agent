import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

import { shouldRespond } from './triage.js';

describe('shouldRespond', () => {
  it('returns true for @bot mention', () => {
    expect(shouldRespond('@Andy what time is dinner?')).toBe(true);
  });

  it('returns true for @bot mention (case insensitive)', () => {
    expect(shouldRespond('@andy hello')).toBe(true);
  });

  it('returns true for slash command (prefixed by channel)', () => {
    expect(shouldRespond('@Andy /today')).toBe(true);
  });

  it('returns false for casual chat', () => {
    expect(shouldRespond('lol that was hilarious')).toBe(false);
  });

  it('returns false for question not addressed to bot', () => {
    expect(shouldRespond('What time is dinner?')).toBe(false);
  });

  it('returns false for mention mid-sentence', () => {
    expect(shouldRespond('hey I heard @Andy knows the wifi')).toBe(false);
  });

  it('returns false for similar name without word boundary', () => {
    expect(shouldRespond('@Andyson hello')).toBe(false);
  });

  it('handles leading whitespace', () => {
    expect(shouldRespond('  @Andy hi')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(shouldRespond('')).toBe(false);
  });
});
