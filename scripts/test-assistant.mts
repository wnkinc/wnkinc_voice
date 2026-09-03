/**
 * Drive the assistant harness for a tenant without Telegram: one turn, the
 * same arguments the Telegram workflow passes (tenant's Gateway OAuth
 * provider, actor id, prompt from the row), reply printed, nothing sent.
 *
 *   npx tsx scripts/test-assistant.mts "who is Sarah?" [tenantId] [name] [role]
 *
 * Repeated runs share a session id, so follow-ups see the thread (memory).
 * SESSION=<suffix> starts a different session for the same actor, to test
 * cross-session recall.
 */
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REGION = 'us-west-2';
const text = process.argv[2] ?? 'What can you help me with?';
const tenantId = process.argv[3] ?? 'wnk';
const name = process.argv[4] ?? 'Test Owner';
const role = process.argv[5] ?? 'owner';
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { businessName: string; description?: string; services?: string[]; hours?: string; timezone?: string; gatewayOauthProviderArn?: string; products?: { assistant?: { enabled?: boolean } } };
if (!tenant.products?.assistant?.enabled) throw new Error(`tenant ${tenantId}: products.assistant.enabled is off`);
if (!tenant.gatewayOauthProviderArn) throw new Error(`tenant ${tenantId}: no gatewayOauthProviderArn; re-run the seed`);
const harnessArn = out('wnk-runtime-dev', 'assistantHarnessArn');
const gatewayArn = `arn:aws:bedrock-agentcore:${REGION}:123456789012:gateway/${out('wnk-gateway-dev', 'gatewayId')}`;

const prompt = [
  `You are My Assistant for ${tenant.businessName}, chatting with ${name} (${role}) who works there.`,
  tenant.description ? `About the business: ${tenant.description}` : '',
  tenant.services?.length ? `Services: ${tenant.services.join(', ')}.` : '',
  tenant.hours ? `Hours: ${tenant.hours}.` : '',
  'This is a chat: be brief and plain, no markdown. Use your tools to look things up or record things; say what you did. If a request needs a tool you do not have, say so in one sentence. Keep replies under 3000 characters.',
].filter(Boolean).join(' ');

console.log(`tenant: ${tenantId}  person: ${name} (${role})\n> ${text}`);
const client = new BedrockAgentCoreClient({ region: REGION });
const res = await client.send(new InvokeHarnessCommand({
  harnessArn,
  runtimeSessionId: `test-assistant-${tenantId}-${process.env.SESSION ?? 'default'}-000000000000000000000000000`,
  actorId: `${tenantId}_test_${role}`,
  messages: [{ role: 'user', content: [{ text }] }],
  systemPrompt: [{ text: prompt }],
  tools: [{ type: 'agentcore_gateway', name: 'wnkgateway', config: { agentCoreGateway: { gatewayArn, outboundAuth: { oauth: { providerArn: tenant.gatewayOauthProviderArn, scopes: ['gateway/assistant'], grantType: 'CLIENT_CREDENTIALS' } } } } }],
  allowedTools: ['@wnkgateway/*'],
}));
let answer = ''; const tools: string[] = []; let usage: unknown;
for await (const ev of res.stream ?? []) {
  if ('contentBlockStart' in ev) { const tu = (ev.contentBlockStart as { start?: { toolUse?: { name?: string } } }).start?.toolUse; if (tu?.name) tools.push(tu.name); }
  if ('contentBlockDelta' in ev) { const d = (ev.contentBlockDelta as { delta?: { text?: string } }).delta; if (d?.text) answer += d.text; }
  if ('metadata' in ev) usage = (ev.metadata as { usage?: unknown }).usage;
  if ('internalServerException' in ev || 'validationException' in ev || 'runtimeClientError' in ev) console.log('stream error:', JSON.stringify(ev).slice(0, 400));
}
console.log(`tools: ${tools.join(', ') || '(none)'} | usage: ${JSON.stringify(usage)}`);
console.log(answer.trim());
