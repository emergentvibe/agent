import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, _resetForTest } from './rate-limit.js';

describe('checkRateLimit', () => {
  beforeEach(() => _resetForTest());

  it('allows requests under the limit', () => {
    const result = checkRateLimit('user1', 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('blocks after hitting the limit', () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit('user1', 3);
    }
    const result = checkRateLimit('user1', 3);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('tracks users independently', () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit('user1', 3);
    }
    const result = checkRateLimit('user2', 3);
    expect(result.allowed).toBe(true);
  });

  it('reports correct remaining count', () => {
    checkRateLimit('user1', 5);
    checkRateLimit('user1', 5);
    const result = checkRateLimit('user1', 5);
    expect(result.remaining).toBe(2);
  });
});
