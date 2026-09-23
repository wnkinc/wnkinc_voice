/** Tenant rows beyond the lookup: every tenant (the canary), and the browser fields the login handoff owns. */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { TenantRow } from '@wnk/shared/contracts';
import { env, now } from './config.js';
import { ddb } from './identity.js';

/** The Tenants table is tiny (one row per called number); a scan is the read. */
export async function listTenants(): Promise<TenantRow[]> {
  const r = await ddb.send(new ScanCommand({ TableName: env('TENANTS_TABLE') }));
  return (r.Items ?? []) as TenantRow[];
}

/**
 * One browser window at a time per tenant: two sessions on one context race
 * on release, and the later one overwrites the earlier one's logins. The row
 * carries the window's end; this claims it, or answers false while one is open.
 */
export async function claimLoginWindow(phoneNumber: string, untilIso: string): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env('TENANTS_TABLE'), Key: { phoneNumber },
      UpdateExpression: 'SET #b.loginUntil = :until',
      ConditionExpression: 'attribute_not_exists(#b.loginUntil) OR #b.loginUntil < :now',
      ExpressionAttributeNames: { '#b': 'browser' },
      ExpressionAttributeValues: { ':until': untilIso, ':now': now() },
    }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export async function clearLoginWindow(phoneNumber: string): Promise<void> {
  await ddb.send(new UpdateCommand({ TableName: env('TENANTS_TABLE'), Key: { phoneNumber }, UpdateExpression: 'REMOVE #b.loginUntil', ExpressionAttributeNames: { '#b': 'browser' } }));
}

export async function saveBrowserContext(phoneNumber: string, contextId: string): Promise<void> {
  await ddb.send(new UpdateCommand({ TableName: env('TENANTS_TABLE'), Key: { phoneNumber }, UpdateExpression: 'SET #b.contextId = :c', ExpressionAttributeNames: { '#b': 'browser' }, ExpressionAttributeValues: { ':c': contextId } }));
}
