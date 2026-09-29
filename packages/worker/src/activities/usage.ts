/** Tokens metered per turn; output costs several times input, so the row carries the split, and how much of the input OpenAI read from its prompt cache. */
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { env, now } from './config.js';
import { ddb } from './clients.js';

export async function recordUsage(tenantId: string, ref: string, tokens: number, inputTokens: number, outputTokens: number, cachedTokens = 0): Promise<void> {
  await ddb.send(new PutCommand({ TableName: env('USAGE_TABLE'), Item: { tenantId, sk: `${now()}#llm_tokens#${randomUUID()}`, meter: 'llm_tokens', units: tokens, inputTokens, outputTokens, cachedTokens, ref } }));
}

/** One unit of any other meter (emails_sent, ...). */
export async function recordMeter(tenantId: string, meter: string, units: number, ref: string): Promise<void> {
  await ddb.send(new PutCommand({ TableName: env('USAGE_TABLE'), Item: { tenantId, sk: `${now()}#${meter}#${randomUUID()}`, meter, units, ref } }));
}
