/**
 * AI Judge — semantic assertion helper for behavioral tests.
 *
 * Uses Haiku to evaluate whether an LLM response meets a behavioral criterion,
 * replacing brittle regex assertions that break on phrasing variance.
 *
 * Usage:
 *   const result = await judge(client, 'mentions dinner time around 7pm', response);
 *   expect(result.pass, result.reason).toBe(true);
 */
import Anthropic from '@anthropic-ai/sdk';

export interface JudgeResult {
  pass: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You are a test assertion judge for a community chatbot. Your job is to evaluate whether a bot's response meets a specific behavioral criterion.

Rules:
- Evaluate the MEANING, not exact words. "7pm" and "seven in the evening" both satisfy "mentions dinner time."
- Be strict about what counts. The criterion must be clearly met, not tangentially related.
- For negative criteria ("does NOT..."), any violation fails.
- The bot is infrastructure for a coliving community. It should be warm, brief, honest, and never take sides.

Respond with ONLY a JSON object: {"pass": true/false, "reason": "one sentence explaining why"}`;

export async function judge(
  client: Anthropic,
  criteria: string,
  response: string,
  context?: string,
): Promise<JudgeResult> {
  const userMessage = [
    `Criterion: ${criteria}`,
    '',
    `Bot response: ${response}`,
    ...(context ? ['', `Context: ${context}`] : []),
    '',
    'Does the response meet the criterion? Reply with JSON only.',
  ].join('\n');

  const result = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = result.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    // Haiku sometimes wraps JSON in markdown code fences
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    return { pass: !!parsed.pass, reason: parsed.reason || 'no reason given' };
  } catch {
    return { pass: false, reason: `Judge returned unparseable response: ${text.slice(0, 200)}` };
  }
}

export async function expectJudge(
  client: Anthropic,
  criteria: string,
  response: string,
  context?: string,
): Promise<void> {
  const result = await judge(client, criteria, response, context);
  if (!result.pass) {
    throw new Error(`AI judge failed: "${criteria}" — ${result.reason}\n\nResponse was: ${response.slice(0, 500)}`);
  }
}
