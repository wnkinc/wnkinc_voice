/**
 * The call row: the transcript (kept off the bus; read here by id) and the
 * once-markers. A marker written after a side effect is hardening against
 * redelivery under at-least-once, not exactly-once: it narrows the duplicate
 * window to a crash between the effect and the mark. Keys are domain
 * identity (done:email:lead:<leadId>), never an event id.
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { TranscriptEntry } from '../types.js';
import { env, epoch, now } from './config.js';
import { ddb } from './identity.js';

/** The marker and, when asked, the transcript. */
export async function readCall(callId: string, key: string, transcript = false): Promise<{ done: boolean; transcript: TranscriptEntry[] }> {
  const r = await ddb.send(new GetCommand({
    TableName: env('CALLS_TABLE'), Key: { callId },
    ProjectionExpression: transcript ? '#k, transcript' : '#k', ExpressionAttributeNames: { '#k': key },
  }));
  const item = r.Item as (Record<string, unknown> & { transcript?: TranscriptEntry[] }) | undefined;
  return { done: Boolean(item?.[key]), transcript: item?.transcript ?? [] };
}

/** Writes the marker with a timestamp (and a TTL if the row has none). `conditional`: false when a marker was written meanwhile. */
export async function markDone(callId: string, key: string, conditional = false): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env('CALLS_TABLE'), Key: { callId },
      UpdateExpression: 'SET #k = :at, expiresAt = if_not_exists(expiresAt, :ttl)',
      ...(conditional ? { ConditionExpression: 'attribute_not_exists(#k)' } : {}),
      ExpressionAttributeNames: { '#k': key },
      ExpressionAttributeValues: { ':at': now(), ':ttl': epoch() + 90 * 86400 },
    }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
