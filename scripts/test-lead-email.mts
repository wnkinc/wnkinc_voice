/**
 * Drive the assistant harness with the lead-email prompt: the same invocation
 * the lead.recorded workflow makes, for one made-up lead. Sends a REAL email
 * to the owner's own Gmail through the tenant's Composio session.
 *
 *   npx tsx scripts/test-lead-email.mts [tenantId] [phone] [callerName] [reason]
 *
 * Actor id is the caller's memory actor (tenant + phone digits), so the
 * harness retrieves what the platform remembers about the caller.
 */
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REGION = 'us-west-2';
const tenantId = process.argv[2] ?? 'wnk';
const phone = process.argv[3] ?? '+15555550155';
const callerName = process.argv[4] ?? 'Jordan Rivera';
const reason = process.argv[5] ?? 'wants an estimate to replace a warped exterior door';
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { businessName: string; composioMcpUrl?: string; products?: { emailResponder?: { enabled?: boolean } } };
if (!tenant.products?.emailResponder?.enabled) throw new Error(`tenant ${tenantId}: products.emailResponder.enabled is off`);
if (!tenant.composioMcpUrl) throw new Error(`tenant ${tenantId}: no composioMcpUrl; connect accounts and re-run the seed`);
const composioProviderArn = out('wnk-identity-dev', 'composioProviderArn');
const harnessArn = out('wnk-runtime-dev', 'assistantHarnessArn');

const lead = { leadId: randomUUID(), createdAt: new Date().toISOString(), tenantId, callId: `test-${Date.now()}`, callerName, phone, reason, preferredCallbackTime: 'weekday mornings' };

// The prompt the workflow will carry. Keep this and the CDK definition in step.
const prompt = [
  `You are My Assistant for ${tenant.businessName}, working for the owner. The phone receptionist just recorded a new lead.`,
  'Your tools reach the business systems the owner connected (CRM, Gmail): search for the right tool, then run it; do not stop at search results.',
  'CRM phone numbers are stored in E.164 form such as +15095551234, so search the phone property with that exact format.',
  'Do exactly this, in order:',
  '1. Look the caller up in the CRM by phone. If found, read their most recent note.',
  '2. Get the owner\'s own Gmail address from the Gmail profile.',
  '3. Send ONE plain-text email from the owner\'s Gmail to that same address. Subject: "New lead: <caller name> - <reason, under 8 words>". Body: two sentences summarizing the lead; then what the CRM history says about this caller, or "No CRM history."; then a suggested 2-3 sentence text message the owner could send the caller. No markdown.',
  '4. Reply with one line: the address you sent to and the subject. Never invent records.',
].join(' ');
const text = `New lead: ${JSON.stringify(lead)}`;

console.log(`tenant: ${tenantId}  lead: ${lead.leadId}\n> ${text}`);
const client = new BedrockAgentCoreClient({ region: REGION });
const started = Date.now();
const res = await client.send(new InvokeHarnessCommand({
  harnessArn,
  runtimeSessionId: `email-lead-${lead.leadId}`,
  actorId: `${tenantId}_${phone.replace(/\D/g, '')}`,
  messages: [{ role: 'user', content: [{ text }] }],
  systemPrompt: [{ text: prompt }],
  tools: [{ type: 'remote_mcp', name: 'crm', config: { remoteMcp: { url: tenant.composioMcpUrl, headers: { 'x-api-key': `\${${composioProviderArn}}` } } } }],
  allowedTools: ['@crm/*'],
}));
let answer = ''; const tools: string[] = []; let usage: unknown;
for await (const ev of res.stream ?? []) {
  if ('contentBlockStart' in ev) { const tu = (ev.contentBlockStart as { start?: { toolUse?: { name?: string } } }).start?.toolUse; if (tu?.name) tools.push(tu.name); }
  if ('contentBlockDelta' in ev) { const d = (ev.contentBlockDelta as { delta?: { text?: string } }).delta; if (d?.text) answer += d.text; }
  if ('metadata' in ev) usage = (ev.metadata as { usage?: unknown }).usage;
  if ('internalServerException' in ev || 'validationException' in ev || 'runtimeClientError' in ev) console.log('stream error:', JSON.stringify(ev).slice(0, 400));
}
console.log(`tools (${tools.length}): ${tools.join(', ') || '(none)'} | usage: ${JSON.stringify(usage)} | ${Math.round((Date.now() - started) / 1000)}s`);
console.log(answer.trim());
