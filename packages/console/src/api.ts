/**
 * Read-only console (disposable v1). One Lambda Function URL serving:
 *   GET /            the single-page UI (Cognito Hosted UI login, PKCE)
 *   GET /api/me      who am I (from the verified ID token)
 *   GET /api/calls   newest calls for MY tenant     GET /api/calls/{id} one call
 *   GET /api/leads   newest leads for MY tenant
 *   GET /api/memories?phone=+1...   what the platform remembers about a caller
 *
 * Tenancy is the point: every query is keyed by the custom:businessId claim in
 * the verified Cognito ID token — the caller cannot ask for another tenant.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { buildInstructions, callerMemory, computeCosts, dynamoStore, listUsage } from '@wnk/shared';
import { PAGE_HTML } from './page.js';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};

const store = dynamoStore();

// The client id arrives via SSM (a direct env var would close a CFN resource
// cycle: function -> client -> callback URL -> function). Cached per container.
let clientIdPromise: Promise<string> | undefined;
function clientId(): Promise<string> {
  clientIdPromise ??= new SSMClient({})
    .send(new GetParameterCommand({ Name: env('CONSOLE_CLIENT_PARAM') }))
    .then((r): string => {
      if (!r.Parameter?.Value) throw new Error('no client id param');
      return r.Parameter.Value;
    });
  return clientIdPromise;
}
const makeVerifier = (id: string) =>
  CognitoJwtVerifier.create({ userPoolId: env('COGNITO_USER_POOL_ID'), clientId: id, tokenUse: 'id' as const });
let verifierPromise: Promise<ReturnType<typeof makeVerifier>> | undefined;
function verifier() {
  verifierPromise ??= clientId().then(makeVerifier);
  return verifierPromise;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function tenantFromAuth(event: APIGatewayProxyEventV2): Promise<{ tenantId: string; email?: string } | undefined> {
  const auth = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return undefined;
  try {
    const claims = await (await verifier()).verify(token);
    const tenantId = claims['custom:businessId'];
    if (typeof tenantId !== 'string' || !tenantId) {
      console.error(JSON.stringify({ msg: 'token verified but no businessId claim', claims: Object.keys(claims) }));
      return undefined;
    }
    return { tenantId, email: typeof claims.email === 'string' ? claims.email : undefined };
  } catch (err) {
    console.error(JSON.stringify({ msg: 'token verification failed', err: String(err) }));
    return undefined;
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath.replace(/\/+$/, '') || '/';

  if (event.requestContext.http.method === 'GET' && (path === '/' || path === '/index.html')) {
    const html = PAGE_HTML
      .replace('__COGNITO_DOMAIN__', env('COGNITO_DOMAIN'))
      .replace('__CLIENT_ID__', await clientId());
    return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
  }

  // Server-side OAuth code exchange (the Cognito token endpoint is unreliable
  // about CORS for browser fetches). Hands the ID token to the page via a tiny
  // bootstrap script, then returns to /.
  if (path === '/auth/callback') {
    const code = event.queryStringParameters?.code;
    if (!code) return json(400, { error: 'missing code' });
    const redirectUri = `https://${event.headers.host}/auth/callback`;
    const res = await fetch(`${env('COGNITO_DOMAIN')}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: await clientId(), code, redirect_uri: redirectUri }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: `token exchange failed: ${res.status} ${detail.slice(0, 300)}` };
    }
    const tokens = (await res.json()) as { id_token: string };
    const body = `<!doctype html><script>sessionStorage.setItem('idt',${JSON.stringify(tokens.id_token)});location.replace('/');</script>`;
    return { statusCode: 200, headers: { 'content-type': 'text/html' }, body };
  }

  if (!path.startsWith('/api/')) return json(404, { error: 'not found' });
  const who = await tenantFromAuth(event);
  if (!who) return json(401, { error: 'sign in required' });
  const { tenantId } = who;

  if (path === '/api/me') return json(200, { tenantId, email: who.email });
  if (path === '/api/calls') {
    const calls = await store.listCalls(tenantId, 50);
    // list view: strip transcripts down to a turn count
    return json(200, calls.map((c) => ({ ...c, transcript: undefined, toolCalls: undefined, turns: c.transcript?.length ?? 0, tools: c.toolCalls?.map((t) => t.name) ?? [] })));
  }
  const callMatch = path.match(/^\/api\/calls\/([\w-]+)$/);
  if (callMatch) {
    const call = await store.getCall(callMatch[1]!);
    if (!call || call.tenantId !== tenantId) return json(404, { error: 'no such call' }); // tenant check, always
    return json(200, call);
  }
  if (path === '/api/leads') return json(200, await store.listLeads(tenantId, 50));
  if (path === '/api/tenant') {
    const config = await store.findTenantById(tenantId);
    if (!config) return json(404, { error: 'no tenant config' });
    return json(200, { config, prompt: buildInstructions(config) });
  }
  if (path === '/api/costs') {
    const month = event.queryStringParameters?.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'month must be YYYY-MM' });
    return json(200, computeCosts(month, await listUsage(tenantId, month)));
  }
  if (path === '/api/memories') {
    const phone = event.queryStringParameters?.phone;
    if (!phone) return json(400, { error: 'phone required' });
    const records = await callerMemory(env('MEMORY_ID')).recall(tenantId, phone, 'who this caller is, their jobs, and their preferences');
    return json(200, { phone, records });
  }
  return json(404, { error: 'not found' });
}
