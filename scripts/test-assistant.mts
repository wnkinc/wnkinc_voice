/**
 * Drive the assistant harness for a tenant without Telegram: one turn, the
 * same arguments the Telegram workflow passes (the tenant's Composio MCP
 * session, actor id, prompt from the row), reply printed, nothing sent.
 *
 *   npx tsx scripts/test-assistant.mts "who is Sarah?" <tenantId> [name] [role]
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
const tenantId = process.argv[3];
if (!tenantId) { console.error('usage: npx tsx scripts/test-assistant.mts "<message>" <tenantId> [name] [role]'); process.exit(2); }
const name = process.argv[4] ?? 'Test Owner';
const role = process.argv[5] ?? 'owner';
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { business: { name: string; description?: string; services?: string[]; hours?: string }; assistant?: { enabled?: boolean; composioMcpUrl?: string } };
if (!tenant.assistant?.enabled) throw new Error(`tenant ${tenantId}: assistant.enabled is off`);
const mcpUrl = tenant.assistant.composioMcpUrl;
if (!mcpUrl) throw new Error(`tenant ${tenantId}: no assistant.composioMcpUrl; connect accounts and re-run the seed`);
const composioProviderArn = out('wnk-identity-dev', 'composioProviderArn');
const harnessArn = out('wnk-runtime-dev', 'assistantHarnessArn');

const prompt = [
  `You are My Assistant for ${tenant.business.name}, chatting with ${name} (${role}) who works there.`,
  tenant.business.description ? `About the business: ${tenant.business.description}` : '',
  tenant.business.services?.length ? `Services: ${tenant.business.services.join(', ')}.` : '',
  tenant.business.hours ? `Hours: ${tenant.business.hours}.` : '',
  mcpUrl ? 'Your tools reach the business systems the owner connected (CRM, email): search for the right tool, then run it; do not stop at search results. CRM phone numbers are stored in E.164 form such as +15095551234, so search the phone property with that exact format.' : '',
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
  // Same as the workflow: the tenant's Composio session, the key by provider ARN.
  tools: [{ type: 'remote_mcp', name: 'crm', config: { remoteMcp: { url: mcpUrl, headers: { 'x-api-key': `\${${composioProviderArn}}` } } } }],
  allowedTools: ['@crm/*'],
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
