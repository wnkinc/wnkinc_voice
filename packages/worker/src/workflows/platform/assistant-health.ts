/**
 * Assistant health canary: on a schedule, prove each tenant's assistant can
 * still complete a turn, before one of its people finds out it cannot. It
 * runs the same loop the channels run, with the tenant's own Composio tools,
 * and reads without writing: it asks after a phone number no contact has.
 * What it asserts is thin on purpose: the loop produced text. Asserting on
 * what the model said would make the canary flaky, and a flaky canary only
 * teaches you to ignore the alarm it rings. A silent tenant fails the
 * workflow, which is the alarm.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import { runAssistantLoop } from '../assistant/loop.js';
import { orElse } from '../common.js';

type Activities = typeof activities;
const reads = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 } });
const memory = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 2 } });

/** Read-only, and no contact carries this number, so the answer is "nothing found" however it is worded. */
export const PROBE_TEXT = 'Search the CRM for the phone number +15555550177 and reply in one short sentence with what you find.';
const PROBE_PROMPT = 'You are a scheduled health probe for a small business assistant. Use your tools to answer, and reply in one short sentence.';

export async function assistantHealth(): Promise<{ probed: string[] }> {
  const tenants = (await reads.listTenants()).filter((t) => t.assistant?.enabled === true);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const silent: string[] = [];
  for (const tenant of tenants) {
    // Its own actor, and a session per day, so the canary's turns never land in a real person's memory.
    const actorId = `${tenant.tenantId}_canary`;
    const sessionId = `canary-${tenant.tenantId}-${day}`;
    const slugs = Object.values(tenant.assistant?.composioTools ?? {}).flat();
    const composioTools = slugs.length > 0 ? await reads.composioToolDefs(slugs) : [];
    const turn = await runAssistantLoop({ tenantId: tenant.tenantId, allowed: [], composioTools, text: PROBE_TEXT, content: PROBE_TEXT, actorId, sessionId, prompt: PROBE_PROMPT });
    if (turn.gaveUp) silent.push(tenant.tenantId);
    else await orElse(memory.saveTurn(actorId, sessionId, PROBE_TEXT, turn.reply), undefined);
  }
  if (silent.length > 0) {
    throw ApplicationFailure.nonRetryable(`the assistant loop produced no text for tenant(s) ${silent.join(', ')}. Check this workflow, then reproduce with scripts/test-assistant.mts against the tenant.`, 'AssistantSilent');
  }
  return { probed: tenants.map((t) => t.tenantId) };
}
