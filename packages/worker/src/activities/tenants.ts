/** Tenant rows beyond the lookup: every tenant (the canaries, through the shared store), and the browser fields the login handoff alone owns. */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { TenantRow } from '@wnk/shared/contracts';
import { env, now } from './config.js';
import { ddb, store } from './clients.js';

export const listTenants = (): Promise<TenantRow[]> => store.listTenants();

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
