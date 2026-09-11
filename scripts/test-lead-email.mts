/**
 * Prove the lead email workflow end to end: put a real lead.recorded event on
 * the bus for a tenant and wait for the once-marker the workflow writes after
 * the send. Sends a REAL email to the owner's own Gmail through Composio.
 *
 *   npx tsx scripts/test-lead-email.mts <tenantId> [phone] [callerName] [reason]
 *
 * Run it twice with the same lead id (LEAD_ID=<uuid>) to see the once-marker
 * skip. The call id is made up, so the marker lands on a throwaway call row
 * that expires with the TTL.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REGION = 'us-west-2';
const tenantId = process.argv[2];
if (!tenantId) { console.error('usage: npx tsx scripts/test-lead-email.mts <tenantId> [phone] [callerName] [reason]'); process.exit(2); }
const phone = process.argv[3] ?? '+15555550155';
const callerName = process.argv[4] ?? 'Jordan Rivera';
const reason = process.argv[5] ?? 'wants an estimate to replace a warped exterior door';
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { phoneNumber: string; products?: { emailResponder?: { enabled?: boolean } } };
if (!tenant.products?.emailResponder?.enabled) throw new Error(`tenant ${tenantId}: products.emailResponder.enabled is off`);
const bus = out('wnk-voice-dev', 'eventBusName');

const callId = `test-lead-${Date.now()}`;
const lead = { leadId: process.env.LEAD_ID ?? randomUUID(), createdAt: new Date().toISOString(), tenantId, callId, callerName, phone, reason, preferredCallbackTime: 'weekday mornings' };
console.log(`tenant: ${tenantId}  callId: ${callId}  leadId: ${lead.leadId}`);
const eb = new EventBridgeClient({ region: REGION });
const put = await eb.send(new PutEventsCommand({ Entries: [{ EventBusName: bus, Source: 'wnkinc.voice', DetailType: 'lead.recorded', Detail: JSON.stringify({ tenantId, tenantPhoneNumber: tenant.phoneNumber, callId, lead }) }] }));
if (put.FailedEntryCount) throw new Error(`put-events failed: ${JSON.stringify(put.Entries)}`);

// Express workflow: no execution listing. Success is the side effect: the
// once-marker on the call row (written after the send).
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const callsTable = process.env.CALLS_TABLE || out('wnk-voice-dev', 'callsTableName');
const started = Date.now();
let marked = false;
while (Date.now() - started < 120_000) {
  await new Promise((r) => setTimeout(r, 3000));
  const row = (await db.send(new GetCommand({ TableName: callsTable, Key: { callId } }))).Item;
  if (row?.[`done:email:lead:${lead.leadId}`]) { marked = true; break; }
}
console.log(marked ? `  ✓ emailed (marker set after ${Math.round((Date.now() - started) / 1000)}s)` : '  ✗ no marker within 2 minutes; check the lead-email log group and the alarm');
