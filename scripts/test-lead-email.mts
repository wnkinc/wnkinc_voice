/**
 * Prove the lead email workflow end to end: put a real lead.recorded event on
 * the bus for a tenant, wait for the execution the rule starts, and print its
 * path. Sends a REAL email to the owner's own Gmail through Composio.
 *
 *   npx tsx scripts/test-lead-email.mts [tenantId] [phone] [callerName] [reason]
 *
 * Run it twice with the same lead id (LEAD_ID=<uuid>) to see the once-marker
 * skip. The call id is made up, so the marker lands on a throwaway call row
 * that expires with the TTL.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SFNClient, GetExecutionHistoryCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REGION = 'us-west-2';
const tenantId = process.argv[2] ?? 'wnk';
const phone = process.argv[3] ?? '+15555550155';
const callerName = process.argv[4] ?? 'Jordan Rivera';
const reason = process.argv[5] ?? 'wants an estimate to replace a warped exterior door';
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { phoneNumber: string; products?: { emailResponder?: { enabled?: boolean } } };
if (!tenant.products?.emailResponder?.enabled) throw new Error(`tenant ${tenantId}: products.emailResponder.enabled is off`);
const bus = out('wnk-voice-dev', 'eventBusName');
const machine = out('wnk-runtime-dev', 'leadEmailWorkflowArn');

const callId = `test-lead-${Date.now()}`;
const lead = { leadId: process.env.LEAD_ID ?? randomUUID(), createdAt: new Date().toISOString(), tenantId, callId, callerName, phone, reason, preferredCallbackTime: 'weekday mornings' };
console.log(`tenant: ${tenantId}  callId: ${callId}  leadId: ${lead.leadId}`);
const eb = new EventBridgeClient({ region: REGION });
const put = await eb.send(new PutEventsCommand({ Entries: [{ EventBusName: bus, Source: 'wnkinc.voice', DetailType: 'lead.recorded', Detail: JSON.stringify({ tenantId, tenantPhoneNumber: tenant.phoneNumber, callId, lead }) }] }));
if (put.FailedEntryCount) throw new Error(`put-events failed: ${JSON.stringify(put.Entries)}`);

const sfn = new SFNClient({ region: REGION });
const started = Date.now();
let exec: { executionArn?: string; status?: string } | undefined;
while (Date.now() - started < 240_000) {
  await new Promise((r) => setTimeout(r, 3000));
  const list = await sfn.send(new ListExecutionsCommand({ stateMachineArn: machine, maxResults: 5 }));
  exec = list.executions?.find((e) => (e.startDate?.getTime() ?? 0) >= started - 5000);
  if (exec && exec.status !== 'RUNNING') break;
}
if (!exec?.executionArn) throw new Error('no execution started within 4 minutes');
console.log(`execution: ${exec.status} (${Math.round((Date.now() - started) / 1000)}s)`);
const hist = await sfn.send(new GetExecutionHistoryCommand({ executionArn: exec.executionArn, maxResults: 200 }));
for (const ev of hist.events ?? []) {
  if (ev.stateExitedEventDetails) console.log(`  ${ev.stateExitedEventDetails.name}`);
  if (ev.executionFailedEventDetails) console.log(`  FAILED: ${ev.executionFailedEventDetails.error} ${ev.executionFailedEventDetails.cause?.slice(0, 300)}`);
}
