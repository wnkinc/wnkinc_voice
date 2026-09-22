/**
 * Workflows: deterministic code Temporal replays from history. No I/O, no
 * clocks beyond the workflow's own, no randomness here; those go through
 * activities. Every export is a workflow type a client can start.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export { smsTurn } from './sms-turn.js';
export { telegramTurn } from './telegram-turn.js';
export { browserLogin } from './browser-login.js';
export { assistantHealth } from './assistant-health.js';
export { composioHealth } from './composio-health.js';
export { crmCall, crmLead, leadEmail, ownerAlert } from './automations.js';

const { echo } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

/** Temporal Cloud invokes the Lambda, the Worker runs a workflow task and an activity, the result comes back. */
export async function ping(name: string): Promise<string> {
  return echo(name);
}
