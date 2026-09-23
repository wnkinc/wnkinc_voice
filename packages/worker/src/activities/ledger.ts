/**
 * The Actions ledger for Facebook posts: one row per draft, never overwritten,
 * so the table is also the log of what was proposed, who approved it, and
 * what came of it. Every write that must happen once is conditional and
 * answers false when the condition failed; nothing here retries a lock.
 */
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ACTION_TYPE, APPROVAL_HOURS, LOG_DAYS, RECENT_MEDIA_HOURS } from '../rules/facebook.js';
import type { DraftRow, Photo } from '@wnk/shared/contracts';
import { env, epoch, now } from './config.js';
import { ddb } from './clients.js';

const table = () => env('ACTIONS_TABLE');
const conditional = async (run: () => Promise<unknown>): Promise<boolean> => {
  try { await run(); return true; } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
};

/** The person's pending, unexpired draft, newest first. */
export async function findPending(tenantId: string, approver: string): Promise<DraftRow | undefined> {
  const r = await ddb.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: 'tenantId = :t AND begins_with(sk, :p)',
    FilterExpression: '#s = :pending AND approveBy > :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':t': tenantId, ':p': `${approver}#${ACTION_TYPE}#`, ':pending': 'pending', ':now': epoch() },
    ScanIndexForward: false,
  }));
  return r.Items?.[0] as DraftRow | undefined;
}

export async function createDraft(tenantId: string, approver: string, caption: string, media: Photo[]): Promise<{ sk: string }> {
  const at = now();
  const sk = `${approver}#${ACTION_TYPE}#${at}#${randomUUID().slice(0, 8)}`;
  await ddb.send(new PutCommand({
    TableName: table(), ConditionExpression: 'attribute_not_exists(sk)',
    Item: {
      tenantId, sk, type: ACTION_TYPE, status: 'pending', approver, proposedBy: 'assistant',
      revision: 1, shownRevision: 0, approveBy: epoch() + APPROVAL_HOURS * 3600,
      payload: { caption, media }, createdAt: at, updatedAt: at, expiresAt: epoch() + LOG_DAYS * 86400,
    },
  }));
  return { sk };
}

/** A change is a new revision the person has not seen: the approval window restarts with it. */
export function reviseDraft(tenantId: string, sk: string, revision: number, caption: string, media: Photo[]): Promise<boolean> {
  return conditional(() => ddb.send(new UpdateCommand({
    TableName: table(), Key: { tenantId, sk },
    UpdateExpression: 'SET payload = :payload, revision = revision + :one, approveBy = :by, updatedAt = :now',
    ConditionExpression: '#s = :pending AND revision = :rev',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':payload': { caption, media }, ':one': 1, ':rev': revision, ':pending': 'pending', ':by': epoch() + APPROVAL_HOURS * 3600, ':now': now() },
  })));
}

export function cancelDraft(tenantId: string, sk: string): Promise<boolean> {
  return conditional(() => ddb.send(new UpdateCommand({
    TableName: table(), Key: { tenantId, sk },
    UpdateExpression: 'SET #s = :rejected, updatedAt = :now',
    ConditionExpression: '#s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':rejected': 'rejected', ':pending': 'pending', ':now': now() },
  })));
}

/**
 * pending -> executing, only on the revision they were shown and only once: a
 * second POST, or one that crossed a revision, finds no pending row at that
 * revision and answers false.
 */
export function lockDraft(tenantId: string, sk: string, revision: number, approver: string, approvalText: string): Promise<boolean> {
  return conditional(() => ddb.send(new UpdateCommand({
    TableName: table(), Key: { tenantId, sk },
    UpdateExpression: 'SET #s = :executing, approvedAt = :now, approvedBy = :who, approvalText = :text, updatedAt = :now',
    ConditionExpression: '#s = :pending AND revision = :rev AND shownRevision = :rev AND approveBy > :epoch',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':executing': 'executing', ':pending': 'pending', ':now': now(), ':who': approver, ':text': approvalText, ':rev': revision, ':epoch': epoch() },
  })));
}

export function markShown(tenantId: string, sk: string, revision: number): Promise<boolean> {
  return conditional(() => ddb.send(new UpdateCommand({
    TableName: table(), Key: { tenantId, sk },
    UpdateExpression: 'SET shownRevision = :rev, shownAt = :now',
    ConditionExpression: '#s = :pending AND revision = :rev',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':rev': revision, ':pending': 'pending', ':now': now() },
  })));
}

export async function markCompleted(tenantId: string, sk: string, postId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: table(), Key: { tenantId, sk },
    UpdateExpression: 'SET #s = :completed, completedAt = :now, #r = :result, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status', '#r': 'result' },
    ExpressionAttributeValues: { ':completed': 'completed', ':now': now(), ':result': { postId } },
  }));
}

export async function markFailed(tenantId: string, sk: string, error: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: table(), Key: { tenantId, sk },
    UpdateExpression: 'SET #s = :failed, #e = :error, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
    ExpressionAttributeValues: { ':failed': 'failed', ':error': error.slice(0, 500), ':now': now() },
  }));
}

/** The publish call did not answer: Facebook may or may not have the post. The row stays `executing` for a person to reconcile. */
export async function markUnconfirmed(tenantId: string, sk: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: table(), Key: { tenantId, sk },
    UpdateExpression: 'SET #e = :error, updatedAt = :now',
    ExpressionAttributeNames: { '#e': 'error' },
    ExpressionAttributeValues: { ':error': 'outcome unknown: the publish call did not answer', ':now': now() },
  }));
}

/** This message's photos, kept for the texts that follow: one row per person, overwritten, not an action. */
export async function rememberMedia(tenantId: string, approver: string, media: Photo[]): Promise<void> {
  await ddb.send(new PutCommand({ TableName: table(), Item: { tenantId, sk: `${approver}#media`, media, updatedAt: now(), expiresAt: epoch() + RECENT_MEDIA_HOURS * 3600 } }));
}

/** The photos from a recent text, if any (the TTL deletes the row late; check the time). */
export async function recentMedia(tenantId: string, approver: string): Promise<Photo[]> {
  const r = await ddb.send(new GetCommand({ TableName: table(), Key: { tenantId, sk: `${approver}#media` } }));
  const item = r.Item as { media?: Photo[]; expiresAt?: number } | undefined;
  return item && (item.expiresAt ?? 0) > epoch() ? (item.media ?? []) : [];
}
