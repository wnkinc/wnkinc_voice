/**
 * Prove the CRM workflows end to end against the tenant's real HubSpot:
 * a lead.recorded event (contact upsert + note + task) and a call.ended
 * event (transcript note on the contact, read from a call row this script
 * writes). Success is judged by side effects: the once-markers on the call
 * row, then the note and task visible through Composio.
 *
 *   npx tsx scripts/test-crm-workflows.mts [tenantId] [phone] [callerName]
 *
 * Needs CALLS_TABLE (voice stack output) or it is read from the stack.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REGION = 'us-west-2';
const tenantId = process.argv[2] ?? 'wnk';
const phone = process.argv[3] ?? '+15555550155';
const callerName = process.argv[4] ?? 'Jordan Rivera';
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();
const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { phoneNumber: string; crm?: unknown };
if (!tenant.crm) throw new Error(`tenant ${tenantId} has no crm block`);
const bus = out('wnk-voice-dev', 'eventBusName');
const callsTable = process.env.CALLS_TABLE || out('wnk-voice-dev', 'callsTableName');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const eb = new EventBridgeClient({ region: REGION });
const publish = (type: string, detail: Record<string, unknown>) =>
  eb.send(new PutEventsCommand({ Entries: [{ EventBusName: bus, Source: 'wnkinc.voice', DetailType: type, Detail: JSON.stringify(detail) }] }));
const waitForMarker = async (callId: string, key: string, ms = 90_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const row = (await db.send(new GetCommand({ TableName: callsTable, Key: { callId } }))).Item;
    if (row?.[`done:${key}`]) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
};

const callId = `test-crm-${Date.now()}`;
const base = { tenantId, tenantPhoneNumber: tenant.phoneNumber, callId };
const now = new Date().toISOString();
// A call row with a transcript, as the session Lambda would leave it.
await db.send(new PutCommand({ TableName: callsTable, Item: {
  callId, tenantId, tenantPhoneNumber: tenant.phoneNumber, from: phone, status: 'completed', startedAt: now, endedAt: now,
  expiresAt: Math.floor(Date.now() / 1000) + 86400,
  transcript: [
    { role: 'assistant', text: 'Thanks for calling, this is Alex. How can I help?', at: now },
    { role: 'user', text: 'CRM workflow proof: I need a quote for a fence repair & a gate.', at: now },
    { role: 'tool', text: 'record_lead(...) -> ok', at: now },
  ],
} }));
const lead = { leadId: randomUUID(), createdAt: now, tenantId, callId, callerName, phone, reason: 'CRM workflow proof: fence repair and a new gate', preferredCallbackTime: 'weekday mornings' };
console.log(`tenant: ${tenantId}  callId: ${callId}  leadId: ${lead.leadId}`);

await publish('lead.recorded', { ...base, lead });
console.log('lead.recorded published; waiting for done:crm:lead...');
console.log(await waitForMarker(callId, `crm:lead:${lead.leadId}`) ? '  ✓ lead synced (marker set)' : '  ✗ no marker within 90 s');

await publish('call.ended', { ...base, callerPhone: phone, status: 'completed', durationSeconds: 61 });
console.log('call.ended published; waiting for done:crm:call...');
console.log(await waitForMarker(callId, 'crm:call') ? '  ✓ transcript note synced (marker set)' : '  ✗ no marker within 90 s');
console.log(`check HubSpot: the contact for ${phone} should show a "Phone lead via receptionist" note, a "Follow up with ${callerName}" task, and a "Call to ... line - 1 min" note.`);
