/**
 * Compare two Composio session shapes for the assistant harness: direct
 * (curated raw tool schemas in context) versus meta (Composio's search and
 * execute meta tools). The Gateway mode of the original comparison is gone
 * with the Gateway; its numbers live in the commit history.
 *
 *   npx tsx scripts/test-composio-mcp.mts "question" [mode: mcp|meta] [tenantId]
 *
 * Creates (or reuses via COMPOSIO_SESSION_ID) a direct-tools Composio session
 * for the tenant with a curated HubSpot + Gmail tool list, then invokes the
 * harness once per mode with a fresh runtime session and prints tools used,
 * token usage, elapsed time, and the reply. Nothing is written to the repo.
 */
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { Composio, SessionPreset } from '@composio/core';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REGION = 'us-west-2';
const text = process.argv[2] ?? 'What can you help me with?';
const mode = process.argv[3] ?? 'meta';
const tenantId = process.argv[4] ?? 'wnk';
const MODEL = process.env.MODEL; // e.g. MODEL=gpt-5.4 overrides the harness default (gpt-5-mini) for this run only
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tenant = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { businessName: string; description?: string; services?: string[]; hours?: string };
const harnessArn = out('wnk-runtime-dev', 'assistantHarnessArn');
const openaiProviderArn = out('wnk-identity-dev', 'openaiProviderArn');
const secret = JSON.parse(execFileSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', out('wnk-voice-dev', 'composioSecretArn'), '--query', 'SecretString', '--output', 'text', '--region', REGION], { encoding: 'utf8' })) as { COMPOSIO_API_KEY: string };

// ---- Composio session: the curated tool list, per tenant, MCP on -------------
// The task-shaped set the Lambda uses, plus HubSpot's generic object tools so
// the model can read note bodies (there is no dedicated read-note tool).
const HUBSPOT_TOOLS = ['HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'HUBSPOT_READ_CONTACT', 'HUBSPOT_CREATE_CONTACT', 'HUBSPOT_UPDATE_CONTACT', 'HUBSPOT_CREATE_NOTE', 'HUBSPOT_CREATE_TASK',
  'HUBSPOT_READ_CRM_OBJECT_BY_ID', 'HUBSPOT_READ_BATCH_OF_CRM_OBJECTS_BY_ID_OR_PROPERTY_VALUES', 'HUBSPOT_SEARCH_CRM_OBJECTS_BY_CRITERIA'];
const GMAIL_TOOLS = ['GMAIL_SEND_EMAIL'];
const composio = new Composio({ apiKey: secret.COMPOSIO_API_KEY });
const t0 = Date.now();
// The tenant's own connected accounts, by tenant id: a session otherwise binds
// only accounts under the project's default auth config, and reports "no
// active connection" for the rest (Composio error 4302).
const accounts = await composio.connectedAccounts.list({ userIds: [tenantId] });
const connectedAccounts: Record<string, string[]> = {};
for (const a of accounts.items) if (a.status === 'ACTIVE' && !a.isDisabled) (connectedAccounts[a.toolkit.slug] ??= []).push(a.id);
if (!connectedAccounts.hubspot) throw new Error(`tenant ${tenantId} has no active HubSpot connected account in Composio`);
// Two Composio session shapes:
//   direct: the curated tool list above, each tool's raw schema in the model's context.
//   meta:   Composio's meta tools (search tools, multi-execute) over the same toolkits;
//           the model discovers schemas at run time, so the context carries a handful
//           of small tools instead of nine large ones.
const sessionKind = mode === 'meta' ? 'meta' : 'direct';
const common = { toolkits: Object.keys(connectedAccounts), connectedAccounts, manageConnections: false, sandbox: { enable: false }, mcp: true as const };
const session = sessionKind === 'meta'
  ? await composio.create(tenantId, { ...common })
  : await composio.create(tenantId, { ...common, sessionPreset: SessionPreset.DIRECT_TOOLS, tools: { hubspot: { enable: HUBSPOT_TOOLS }, ...(connectedAccounts.gmail ? { gmail: { enable: GMAIL_TOOLS } } : {}) } });
const mcp = session.mcp;
console.log(`composio session ${session.sessionId} [${sessionKind}] (${Date.now() - t0}ms) accounts ${JSON.stringify(connectedAccounts)}\n  mcp url: ${mcp.url}\n  mcp headers: ${Object.keys(mcp.headers ?? {}).join(', ') || '(none)'}`);

const prompt = [
  `You are My Assistant for ${tenant.businessName}, chatting with Jordan (owner) who works there.`,
  tenant.description ? `About the business: ${tenant.description}` : '',
  tenant.services?.length ? `Services: ${tenant.services.join(', ')}.` : '',
  'This is a chat: be brief and plain, no markdown. Use your tools to look things up or record things; say what you did and what you found. Never invent records. Keep replies under 3000 characters.',
].filter(Boolean).join(' ');

const TOOLS = {
  meta: { tools: [{ type: 'remote_mcp', name: 'crm', config: { remoteMcp: { url: mcp.url, headers: { ...(mcp.headers ?? {}), 'x-api-key': secret.COMPOSIO_API_KEY } } } }], allowed: ['@crm/*'] },
  mcp: { tools: [{ type: 'remote_mcp', name: 'crm', config: { remoteMcp: { url: mcp.url, headers: { ...(mcp.headers ?? {}), 'x-api-key': secret.COMPOSIO_API_KEY } } } }], allowed: ['@crm/*'] },
} as const;

const client = new BedrockAgentCoreClient({ region: REGION });
async function run(which: keyof typeof TOOLS): Promise<void> {
  const started = Date.now();
  const res = await client.send(new InvokeHarnessCommand({
    harnessArn,
    runtimeSessionId: `mcp-proto-${which}-${tenantId}-${process.env.SESSION ?? started}-000000000000000000000`,
    // Fresh actor per run: memory is per actor, so nothing from earlier runs leaks in.
    actorId: `${tenantId}_mcpproto_${which}_${started}`,
    messages: [{ role: 'user', content: [{ text }] }],
    systemPrompt: [{ text: prompt }],
    ...(MODEL ? { model: { openAiModelConfig: { modelId: MODEL, apiKeyArn: openaiProviderArn, apiFormat: 'responses', maxTokens: 1200 } } } : {}),
    tools: TOOLS[which].tools as never,
    allowedTools: [...TOOLS[which].allowed],
  }));
  let answer = ''; const tools: string[] = []; let usage: unknown; const errors: string[] = [];
  for await (const ev of res.stream ?? []) {
    if ('contentBlockStart' in ev) { const tu = (ev.contentBlockStart as { start?: { toolUse?: { name?: string } } }).start?.toolUse; if (tu?.name) tools.push(tu.name); }
    if ('contentBlockDelta' in ev) { const d = (ev.contentBlockDelta as { delta?: { text?: string } }).delta; if (d?.text) answer += d.text; }
    if ('metadata' in ev) usage = (ev.metadata as { usage?: unknown }).usage;
    if ('internalServerException' in ev || 'validationException' in ev || 'runtimeClientError' in ev) errors.push(JSON.stringify(ev).slice(0, 400));
  }
  console.log(`\n=== ${which.toUpperCase()} (${MODEL ?? 'gpt-5-mini'})  ${((Date.now() - started) / 1000).toFixed(1)}s\ntools: ${tools.join(', ') || '(none)'}\nusage: ${JSON.stringify(usage)}${errors.length ? `\nerrors: ${errors.join(' | ')}` : ''}\n${answer.trim()}`);
}

console.log(`\n> ${text}`);
if (mode === 'mcp') await run('mcp');
if (mode === 'meta') await run('meta');
