/** Tokens metered per turn; output costs several times input, so the row carries the split. */
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { env, now } from './config.js';
import { ddb } from './identity.js';

export async function recordUsage(tenantId: string, ref: string, tokens: number, inputTokens: number, outputTokens: number): Promise<void> {
  await ddb.send(new PutCommand({ TableName: env('USAGE_TABLE'), Item: { tenantId, sk: `${now()}#llm_tokens#${randomUUID()}`, meter: 'llm_tokens', units: tokens, inputTokens, outputTokens, ref } }));
}
