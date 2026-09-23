/**
 * Composio health canary: on a schedule, prove every tenant's Composio
 * connections are still ACTIVE before a caller finds out they are not. A
 * revoked connection fails nothing on its own (enrichment carries on
 * without it), so this turns that silence into a failed workflow, which
 * alarms. What each row promises is read from its own flags
 * (rules/automations.ts expectedToolkits); a new tenant is covered by the
 * scan; nothing here names one.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import { expectedToolkits, missingToolkits } from '../../rules/automations.js';

const reads = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 } });

export async function composioHealth(): Promise<{ checked: string[] }> {
  const tenants = await reads.listTenants();
  const problems: string[] = [];
  const checked: string[] = [];
  for (const t of tenants) {
    const expected = expectedToolkits(t);
    const needsAny = t.assistant?.enabled === true;
    if (expected.length === 0 && !needsAny) continue;
    checked.push(t.tenantId);
    const active = (await reads.composioAccounts(t.tenantId)).map((a) => a.toolkit);
    const missing = missingToolkits(expected, active);
    if (missing.length > 0) problems.push(`tenant ${t.tenantId}: no ACTIVE Composio account for ${missing.join(', ')}`);
    else if (needsAny && active.length === 0) problems.push(`tenant ${t.tenantId}: assistant is on but no ACTIVE Composio account at all`);
  }
  if (problems.length > 0) throw ApplicationFailure.nonRetryable(`${problems.join('; ')}. Reconnect: npx tsx scripts/connect-composio.mts <tenantId> <toolkit>`, 'ComposioConnectionMissing');
  return { checked };
}
