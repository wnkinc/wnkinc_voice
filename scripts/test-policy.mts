// Phase-4 verification: per-identity allow/deny matrix through the gateway.
import { execFileSync } from 'node:child_process';
const aws = (a: string[]) => execFileSync('aws', [...a, '--region', 'us-west-2'], { encoding: 'utf8' }).trim();
const out = (s: string, k: string) => aws(['cloudformation', 'describe-stacks', '--stack-name', s, '--query', `Stacks[0].Outputs[?OutputKey=='${k}'].OutputValue | [0]`, '--output', 'text']);
const poolId = out('wnk-auth-dev', 'userPoolId');
const tokenUrl = out('wnk-auth-dev', 'tokenUrl');
const gatewayUrl = out('wnk-gateway-dev', 'gatewayUrl');

async function tokenFor(clientId: string): Promise<string> {
  const secret = aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId, '--query', 'UserPoolClient.ClientSecret', '--output', 'text']);
  const r = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` }, body: 'grant_type=client_credentials&scope=gateway%2Finvoke' });
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

const clients = {
  admin: out('wnk-auth-dev', 'machineClientId'),
  voice: out('wnk-auth-dev', 'voiceClientId'),
  email: out('wnk-auth-dev', 'emailClientId'),
};
const tokens: Record<string, string> = {};
for (const [k, id] of Object.entries(clients)) tokens[k] = await tokenFor(id);

const leadArgs = { caller_name: 'Policy Test', reason: 'phase 4 check', tenant_id: 'wnk', tenant_phone: '+15555550100', call_id: 'policy-test-1' };
const cases: Array<[string, string, unknown, string]> = [
  ['admin', 'hubspot___searchContacts', { query: 'Jordan', limit: 1 }, 'expect ALLOW'],
  ['voice', 'voice___notify_owner', { summary: 'phase 4 policy check', tenant_id: 'wnk', tenant_phone: '+15555550100', call_id: 'policy-test-1' }, 'expect ALLOW'],
  ['voice', 'voice___record_lead', { ...leadArgs, tenant_id: 'any-other-tenant' }, 'expect ALLOW (tenant context present; the Lambda resolved it, not the model)'],
  ['voice', 'voice___record_lead', { ...leadArgs, tenant_id: '' }, 'expect DENY (no tenant context)'],
  ['voice', 'hubspot___searchContacts', { query: 'Jordan', limit: 1 }, 'expect DENY (not its tool)'],
  ['email', 'hubspot___searchContacts', { query: 'Jordan', limit: 1 }, 'expect ALLOW'],
  ['email', 'hubspot___createContact', { properties: { firstname: 'Nope' } }, 'expect DENY (read-only)'],
  ['email', 'voice___record_lead', leadArgs, 'expect DENY (not its tool)'],
];
for (const [who, tool, args, expect] of cases) {
  console.log(`${who.padEnd(6)} ${tool.padEnd(28)} [${expect}] ->`, await call(tokens[who]!, tool, args));
}
