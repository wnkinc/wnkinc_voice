/**
 * Drive the assistant for a tenant end to end: start the Telegram workflow
 * with a synthetic update from the tenant's owner and wait for it. The reply
 * is delivered to the owner on Telegram, exactly as a real message would be,
 * and printed here from the execution history.
 *
 *   npx tsx scripts/test-assistant.mts "who is Sarah?" <tenantId>
 *
 * Same day, same owner: follow-ups share the memory session, so the thread
 * carries. Needs the owner listed in the tenant file with a telegramId.
 */
import { GetExecutionHistoryCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REGION = 'us-west-2';
const text = process.argv[2] ?? 'What can you help me with?';
const tenantId = process.argv[3];
if (!tenantId) { console.error('usage: npx tsx scripts/test-assistant.mts "<message>" <tenantId>'); process.exit(2); }
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { assistant?: { enabled?: boolean }; people?: { name: string; role: string; telegramId?: number }[] };
if (!tenant.assistant?.enabled) throw new Error(`tenant ${tenantId}: assistant.enabled is off`);
const owner = tenant.people?.find((p) => p.role === 'owner' && p.telegramId);
if (!owner?.telegramId) throw new Error(`tenant ${tenantId}: no owner with a telegramId in people`);

const sfn = new SFNClient({ region: REGION });
const update = { update_id: Date.now(), message: { message_id: Date.now(), from: { id: owner.telegramId, first_name: owner.name }, chat: { id: owner.telegramId, type: 'private' }, text } };
console.log(`tenant: ${tenantId}  as: ${owner.name} (owner, telegram ${owner.telegramId})\n> ${text}`);
const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn: out('wnk-runtime-dev', 'telegramWorkflowArn'), input: JSON.stringify(update) }));

let status = 'RUNNING';
for (let i = 0; i < 90 && status === 'RUNNING'; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await sfn.send(new GetExecutionHistoryCommand({ executionArn, reverseOrder: true, maxResults: 5 }));
  const last = h.events?.[0]?.type ?? '';
  if (last.startsWith('Execution') && last !== 'ExecutionStarted') status = last;
}
const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 500 }));
const tools = (history.events ?? []).filter((e) => e.type === 'TaskStateEntered' && /^Run_/.test(e.stateEnteredEventDetails?.name ?? '')).map((e) => e.stateEnteredEventDetails?.name?.slice(4));
const reply = (history.events ?? []).find((e) => e.type === 'TaskScheduled' && e.taskScheduledEventDetails?.resourceType === 'events');
const detail = reply?.taskScheduledEventDetails?.parameters ? (JSON.parse(reply.taskScheduledEventDetails.parameters) as { Entries?: { Detail?: string }[] }).Entries?.[0]?.Detail : undefined;
console.log(`${status} | tools: ${tools.join(', ') || '(none)'} | ${executionArn.split(':').pop()}`);
console.log(detail ? (JSON.parse(detail) as { text: string }).text : '(no reply sent; see the execution)');
