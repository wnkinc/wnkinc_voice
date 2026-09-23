/**
 * owner.notify -> the owner's Telegram. No once-marker: an alert delivered
 * twice on a rare redelivery is harmless. A tenant with the tool on but no
 * owner channel fails loudly.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import type { OwnerNotify } from '@wnk/shared/contracts';
import type { AutomationOutcome } from './common.js';

type Activities = typeof activities;
const rows = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const replies = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds' } });

export async function ownerAlert(event: OwnerNotify): Promise<AutomationOutcome> {
  const tenant = await rows.lookupTenant(event.tenantPhoneNumber);
  const owner = tenant?.people?.find((p) => p.role === 'owner' && p.telegramId);
  if (!tenant || !owner?.telegramId) throw ApplicationFailure.nonRetryable('The tenant has no owner with a Telegram id; add one under people and re-seed', 'NoOwnerChannel');
  await replies.sendTelegram(owner.telegramId, `${event.urgency === 'urgent' ? 'URGENT' : 'Heads up'} (${tenant.business.name}): ${event.summary}${event.callerPhone ? ` Caller: ${event.callerPhone}` : ''}`);
  return 'done';
}
