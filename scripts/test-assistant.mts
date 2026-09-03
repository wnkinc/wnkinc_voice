/**
 * Drive the assistant without Telegram: one turn, reply printed, nothing sent.
 *
 *   npx tsx scripts/test-assistant.mts "who is Sarah?" [tenantId] [name] [role]
 *
 * The tenant must have products.assistant.enabled — the agent stays silent otherwise.
 * Repeated runs share a session id, so follow-ups see the thread.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { execFileSync } from 'node:child_process';

const text = process.argv[2] ?? 'What can you help me with?';
const tenantId = process.argv[3] ?? 'wnk';
const name = process.argv[4] ?? 'Test Owner';
const role = (process.argv[5] ?? 'owner') as 'owner' | 'employee';

const arn = execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', 'wnk-runtime-dev', '--query', "Stacks[0].Outputs[?OutputKey=='assistantRuntimeArn'].OutputValue | [0]", '--output', 'text', '--region', 'us-west-2'], { encoding: 'utf8' }).trim();
const client = new BedrockAgentCoreClient({ region: 'us-west-2' });
console.log(`tenant: ${tenantId}  person: ${name} (${role})\n> ${text}`);
const res = await client.send(new InvokeAgentRuntimeCommand({
  agentRuntimeArn: arn,
  qualifier: 'DEFAULT',
  runtimeSessionId: `test-assistant-${tenantId}-000000000000000000000000000000`,
  contentType: 'application/json',
  accept: 'application/json',
  payload: Buffer.from(JSON.stringify({ tenantId, person: { name, role }, channelId: `test:${tenantId}`, channel: { type: 'none' }, text })),
}));
const body = res.response ? Buffer.from(await res.response.transformToByteArray()).toString('utf8') : '';
const parsed = JSON.parse(body) as { ok?: boolean; reply?: string; skipped?: string; error?: string };
console.log(`status ${res.statusCode}`);
console.log(parsed.reply ?? parsed.skipped ?? parsed.error ?? body);
