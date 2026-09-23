/**
 * Workflows: deterministic code Temporal replays from history. No I/O, no
 * clocks beyond the workflow's own, no randomness here; those go through
 * activities. Every export is a workflow type a client can start.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

// The assistant: a person of the tenant, over a channel.
export { smsTurn } from './assistant/sms-turn.js';
export { telegramTurn } from './assistant/telegram-turn.js';
export { browserLogin } from './assistant/browser-login.js';
// The tenant automations: a tenant file lists them; a tenant stack's rule starts each.
export { leadEmail } from './automations/lead-email.js';
export { crmLead } from './automations/crm-lead.js';
export { crmCall } from './automations/crm-call.js';
export { ownerAlert } from './automations/owner-alert.js';
// The platform's own: every tenant identically, by the worker stack's rule or a schedule.
export { callEnded } from './platform/call-ended.js';
export { assistantHealth } from './platform/assistant-health.js';
export { composioHealth } from './platform/composio-health.js';

const { echo } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

/** Temporal Cloud invokes the Lambda, the Worker runs a workflow task and an activity, the result comes back. */
export async function ping(name: string): Promise<string> {
  return echo(name);
}
