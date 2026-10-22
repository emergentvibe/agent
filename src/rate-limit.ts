const DEFAULT_MAX_REQUESTS = 20;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface Window {
  count: number;
  start: number;
}

const windows = new Map<string, Window>();

export function checkRateLimit(
  userId: string,
  maxRequests = parseInt(process.env.USER_HOURLY_LIMIT || '', 10) ||
    DEFAULT_MAX_REQUESTS,
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const existing = windows.get(userId);

  if (!existing || now - existing.start >= WINDOW_MS) {
    windows.set(userId, { count: 1, start: now });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (existing.count >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  existing.count++;
  return { allowed: true, remaining: maxRequests - existing.count };
}

export function _resetForTest(): void {
  windows.clear();
}
