// Phase-4 verification: per-identity allow/deny matrix through the gateway.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const aws = (a: string[]) => execFileSync('aws', [...a, '--region', 'us-west-2'], { encoding: 'utf8' }).trim();
const out = (s: string, k: string) => aws(['cloudformation', 'describe-stacks', '--stack-name', s, '--query', `Stacks[0].Outputs[?OutputKey=='${k}'].OutputValue | [0]`, '--output', 'text']);
const poolId = out('wnk-auth-dev', 'userPoolId');
const tokenUrl = out('wnk-auth-dev', 'tokenUrl');
const gatewayUrl = out('wnk-gateway-dev', 'gatewayUrl');

async function tokenFor(clientId: string, scope: string): Promise<string> {
  const secret = aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId, '--query', 'UserPoolClient.ClientSecret', '--output', 'text']);
  const r = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` }, body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}` });
  return ((await r.json()) as { access_token: string }).access_token;
}
async function call(token: string, name: string, args: unknown): Promise<string> {
  const r = await fetch(gatewayUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const d = t.includes('data:') ? (t.split('\n').filter((l) => l.startsWith('data:')).pop() ?? '').slice(5) : t;
  const p = JSON.parse(d) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
  if (p.error) return `RPC-ERROR: ${p.error.message?.slice(0, 80)}`;
  if (p.result?.isError) return `DENIED/ERROR: ${p.result.content?.[0]?.text?.slice(0, 90)}`;
  return `ALLOWED: ${p.result?.content?.[0]?.text?.slice(0, 60)}`;
}

// Identities: the admin client (every scope, names the tenant itself) and
// wnk's own client with each agent scope (the Gateway attributes the tenant).
const wnk = JSON.parse(readFileSync('tenants/wnk.json', 'utf8')) as { cognitoClientId?: string; phoneNumber: string };
if (!wnk.cognitoClientId) throw new Error('tenants/wnk.json has no cognitoClientId; seed first');
const admin = out('wnk-auth-dev', 'machineClientId');
const tokens: Record<string, string> = {
  admin: await tokenFor(admin, 'gateway/invoke'),
  voice: await tokenFor(wnk.cognitoClientId, 'gateway/voice'),
  email: await tokenFor(wnk.cognitoClientId, 'gateway/email'),
  assistant: await tokenFor(wnk.cognitoClientId, 'gateway/assistant'),
};

const leadArgs = { caller_name: 'Policy Test', reason: 'policy check', call_id: 'policy-test-1' };
const cases: Array<[string, string, unknown, string]> = [
  ['admin', 'crm___search_contacts', { query: 'Composio', limit: 1, tenant_id: 'wnk', tenant_phone: wnk.phoneNumber }, 'expect ALLOW (admin names the tenant)'],
  ['voice', 'voice___notify_owner', { summary: 'policy check', ...leadArgs }, 'expect ALLOW (tenant from identity)'],
  ['voice', 'voice___record_lead', { ...leadArgs, tenant_id: 'any-other-tenant' }, 'expect ALLOW as wnk (interceptor overwrote the tenant)'],
  ['voice', 'crm___search_contacts', { query: 'Composio', limit: 1 }, 'expect DENY (not its scope)'],
  ['email', 'crm___search_contacts', { query: 'Composio', limit: 1 }, 'expect ALLOW'],
  ['email', 'crm___add_note', { contact_id: '0', body: 'nope' }, 'expect DENY (read-only)'],
  ['email', 'voice___record_lead', leadArgs, 'expect DENY (not its scope)'],
  ['assistant', 'crm___search_contacts', { query: 'Composio', limit: 1 }, 'expect ALLOW'],
  ['assistant', 'voice___record_lead', leadArgs, 'expect DENY (not its scope)'],
  ['assistant', 'linkedin___get_profile', {}, 'expect ALLOW (tool errors until the tenant consents)'],
  ['email', 'linkedin___get_profile', {}, 'expect DENY (not its scope)'],
  ['voice', 'linkedin___create_post', { text: 'nope' }, 'expect DENY (not its scope)'],
];
for (const [who, tool, args, expect] of cases) {
  console.log(`${who.padEnd(6)} ${tool.padEnd(28)} [${expect}] ->`, await call(tokens[who]!, tool, args));
}
