/**
 * Phase-1 proof: talk to the AgentCore Gateway as an MCP client.
 *
 *   npx tsx scripts/test-gateway.ts [search query] [clientId|machine] [scope]
 *
 * Gets a client-credentials JWT from Cognito, then: initialize -> tools/list ->
 * tools/call hubspot___searchContacts. Reads stack outputs + the client secret
 * via the AWS CLI, so it needs the same credentials as a deploy.
 *
 * Pass a tenant's cognitoClientId (from its tenant file) and an agent scope
 * such as gateway/assistant to exercise the interceptor path: the Gateway
 * attributes the call to the tenant and injects tenant context itself.
 */
import { execFileSync } from 'node:child_process';

const REGION = 'us-west-2';
const aws = (args: string[]): string => execFileSync('aws', [...args, '--region', REGION], { encoding: 'utf8' }).trim();

function stackOutput(stack: string, key: string): string {
  return aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text']);
}

async function mcp(url: string, token: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${res.status}: ${text.slice(0, 500)}`);
  // Streamable HTTP may answer as SSE; take the last data: line.
  const data = text.startsWith('event:') || text.includes('\ndata:') ? (text.split('\n').filter((l) => l.startsWith('data:')).pop() ?? '').slice(5) : text;
  return JSON.parse(data);
}

const query = process.argv[2] ?? 'Jordan';
const clientArg = process.argv[3] ?? 'machine';
const scope = process.argv[4] ?? 'gateway/invoke';

const userPoolId = stackOutput('wnk-auth-dev', 'userPoolId');
const clientId = clientArg === 'machine' ? stackOutput('wnk-auth-dev', 'machineClientId') : clientArg;
const tokenUrl = stackOutput('wnk-auth-dev', 'tokenUrl');
const gatewayUrl = stackOutput('wnk-gateway-dev', 'gatewayUrl');
const clientSecret = aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', userPoolId, '--client-id', clientId, '--query', 'UserPoolClient.ClientSecret', '--output', 'text']);
console.log(`gateway: ${gatewayUrl}`);

const tokenRes = await fetch(tokenUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
  },
  body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
});
if (!tokenRes.ok) throw new Error(`token endpoint ${tokenRes.status}: ${await tokenRes.text()}`);
const { access_token } = (await tokenRes.json()) as { access_token: string };
console.log(`got JWT via client_credentials as ${clientArg} with scope ${scope}`);

await mcp(gatewayUrl, access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-gateway', version: '0.1.0' } } });
console.log('MCP initialize ok');

const tools = (await mcp(gatewayUrl, access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })) as { result?: { tools?: Array<{ name: string }> } };
console.log('tools:', (tools.result?.tools ?? []).map((t) => t.name).join(', ') || '(none)');

const call = await mcp(gatewayUrl, access_token, {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'hubspot___searchContacts', arguments: { query, limit: 3 } },
});
console.log('searchContacts result:');
console.log(JSON.stringify(call, null, 2).slice(0, 2500));
