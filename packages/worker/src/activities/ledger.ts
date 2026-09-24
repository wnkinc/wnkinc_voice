/**
 * The Actions ledger for Facebook posts: one row per draft, never overwritten,
 * so the table is also the log of what was proposed, who approved it, and
 * what came of it. Every write that must happen once is conditional and
 * answers false when the condition failed; nothing here retries a lock.
 *
 * Beside the drafts, one row per photo a person texted (PhotoRow): what a
 * human assistant would remember of the thread. A draft names photos by row;
 * a post marks the rows it used.
 */
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ACTION_TYPE, APPROVAL_HOURS, LOG_DAYS, PHOTO_LIST_DAYS, PHOTO_LIST_MAX } from '../rules/facebook.js';
import type { DraftRow, PhotoRef, PhotoRow } from '@wnk/shared/contracts';
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

export async function createDraft(tenantId: string, approver: string, caption: string, media: PhotoRef[]): Promise<{ sk: string }> {
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
export function reviseDraft(tenantId: string, sk: string, revision: number, caption: string, media: PhotoRef[]): Promise<boolean> {
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

// ---- The photos a person texted -------------------------------------------------

/** The rows for this text's photos, as the workflow built them (the key from the store, the time the workflow's). A retry writes the same rows. */
export async function putPhotos(rows: PhotoRow[]): Promise<void> {
  for (const row of rows) await ddb.send(new PutCommand({ TableName: table(), Item: row }));
}

/** The person's photos of the last PHOTO_LIST_DAYS, oldest first, at most PHOTO_LIST_MAX (the newest). */
export async function listPhotos(tenantId: string, approver: string): Promise<PhotoRow[]> {
  const since = new Date(Date.now() - PHOTO_LIST_DAYS * 86400_000).toISOString();
  const r = await ddb.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: 'tenantId = :t AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':t': tenantId, ':from': `${approver}#photo#${since}`, ':to': `${approver}#photo#~` },
    ScanIndexForward: false, Limit: PHOTO_LIST_MAX,
  }));
  return ((r.Items ?? []) as PhotoRow[]).reverse();
}

/** What a vision call said each photo shows, one line per row, in order. */
export async function describePhotoRows(tenantId: string, sks: string[], descriptions: string[]): Promise<void> {
  for (const [i, sk] of sks.entries()) {
    const description = descriptions[i];
    if (!description) continue;
    await ddb.send(new UpdateCommand({ TableName: table(), Key: { tenantId, sk }, UpdateExpression: 'SET description = :d', ExpressionAttributeValues: { ':d': description } }));
  }
}

/** The photos a post went out with, marked with the action row, so the model sees them as used. */
export async function markPhotosPosted(tenantId: string, sks: string[], actionSk: string): Promise<void> {
  for (const sk of sks) {
    await ddb.send(new UpdateCommand({ TableName: table(), Key: { tenantId, sk }, UpdateExpression: 'SET postedIn = :a, postedAt = :now', ExpressionAttributeValues: { ':a': actionSk, ':now': now() } }));
  }
}
