/**
 * Drive the assistant for a tenant end to end: start the Telegram turn on the
 * worker with a synthetic update from the tenant's owner and wait for it. The
 * reply is delivered to the owner on Telegram, exactly as a real message
 * would be, and printed here from the workflow history.
 *
 *   npx tsx scripts/test-assistant.mts "who is Sarah?" <tenantId>
 *
 * Same day, same owner: follow-ups share the memory session, so the thread
 * carries. Needs the owner listed in the tenant file with a telegramId.
 */
import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { TASK_QUEUE } from '../packages/worker/src/version.js';
import { temporalSecret } from './lib/temporal-env.mts';

const text = process.argv[2] ?? 'What can you help me with?';
const tenantId = process.argv[3];
if (!tenantId) { console.error('usage: npx tsx scripts/test-assistant.mts "<message>" <tenantId>'); process.exit(2); }

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { assistant?: { enabled?: boolean }; people?: { name: string; role: string; telegramId?: number }[] };
if (!tenant.assistant?.enabled) throw new Error(`tenant ${tenantId}: assistant.enabled is off`);
const owner = tenant.people?.find((p) => p.role === 'owner' && p.telegramId);
if (!owner?.telegramId) throw new Error(`tenant ${tenantId}: no owner with a telegramId in people`);

const s = await temporalSecret();
const client = new Client({ connection: await Connection.connect({ address: s.TEMPORAL_ADDRESS!, tls: true, apiKey: s.TEMPORAL_API_KEY! }), namespace: s.TEMPORAL_NAMESPACE! });
const updateId = Date.now();
const update = { update_id: updateId, message: { message_id: updateId, from: { id: owner.telegramId, first_name: owner.name }, chat: { id: owner.telegramId, type: 'private' }, text } };
console.log(`tenant: ${tenantId}  as: ${owner.name} (owner, telegram ${owner.telegramId})\n> ${text}`);
const handle = await client.workflow.start('telegramTurn', { taskQueue: TASK_QUEUE, workflowId: `telegram-${updateId}`, args: [update] });
const outcome = await handle.result();

const tools: string[] = [];
let reply: string | undefined;
for (const e of (await handle.fetchHistory()).events ?? []) {
  const a = e.activityTaskScheduledEventAttributes;
  if (!a) continue;
  const args = (a.input?.payloads ?? []).map((p) => JSON.parse(Buffer.from(p.data ?? []).toString()) as unknown);
  if (a.activityType?.name === 'executeTool') tools.push(String(args[1]));
  if (a.activityType?.name === 'sendTelegram') reply = String(args[1]);
}
console.log(`${outcome} | tools: ${tools.join(', ') || '(none)'} | ${handle.workflowId}`);
console.log(reply ?? '(no reply sent; see the workflow)');
await client.connection.close();
