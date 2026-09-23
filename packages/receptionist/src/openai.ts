/** The OpenAI client for the call path: short timeout, one retry, since the caller is waiting. */
import OpenAI from 'openai';
import type { OpenAISecrets } from '@wnk/shared';

export function createOpenAI(s: OpenAISecrets): OpenAI {
  return new OpenAI({ apiKey: s.OPENAI_API_KEY, webhookSecret: s.OPENAI_WEBHOOK_SECRET, maxRetries: 1, timeout: 8_000 });
}
