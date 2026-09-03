/**
 * Minimal MCP client for the AgentCore Gateway, shared by every agent.
 * Auth: Cognito client-credentials JWT (the client secret is read once via
 * DescribeUserPoolClient); tokens are cached until shortly before expiry.
 */
import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';

export interface GatewayClientConfig {
  gatewayUrl: string;
  tokenUrl: string;
  userPoolId: string;
  /** The Cognito app client to act as: a tenant's own client (see TenantConfig.cognitoClientId). */
  clientId: string;
  /** OAuth scope naming the agent (gateway/assistant, gateway/email, gateway/voice); Policy keys on it. */
  scope?: string;
}

export interface GatewayTool {
  name: string;
  description?: string;
  /** JSON schema of the tool's arguments, as the Gateway publishes it. */
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

export interface GatewayClient {
  /** Call one MCP tool (full name, e.g. `voice___record_lead`); returns the text content. */
  callTool(name: string, args: unknown): Promise<string>;
  /** The catalog: every tool the caller's identity may see. Policy still decides what it may call. */
  listTools(): Promise<GatewayTool[]>;
}

/** Config from the standard env vars, or undefined when the gateway isn't wired. */
export function gatewayConfigFromEnv(): GatewayClientConfig | undefined {
  const { GATEWAY_URL, COGNITO_TOKEN_URL, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, GATEWAY_SCOPE } = process.env;
  if (!GATEWAY_URL || !COGNITO_TOKEN_URL || !COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) return undefined;
  return { gatewayUrl: GATEWAY_URL, tokenUrl: COGNITO_TOKEN_URL, userPoolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID, scope: GATEWAY_SCOPE };
}

const perClient = new Map<string, GatewayClient>();

/**
 * A Gateway client acting as the tenant (its own Cognito app client), with the
 * calling agent's scope from the env config. Cached per client id. Refuses a
 * tenant that has no client: nothing may act for a tenant the Gateway cannot
 * attribute.
 */
export function tenantGatewayClient(base: GatewayClientConfig, tenant: { tenantId: string; cognitoClientId?: string }): GatewayClient {
  if (!tenant.cognitoClientId) throw new Error(`tenant "${tenant.tenantId}" has no cognitoClientId; re-run the seed to create its Gateway identity`);
  let client = perClient.get(tenant.cognitoClientId);
  if (!client) {
    client = gatewayClient({ ...base, clientId: tenant.cognitoClientId });
    perClient.set(tenant.cognitoClientId, client);
  }
  return client;
}

export function gatewayClient(config: GatewayClientConfig): GatewayClient {
  let cached: { token: string; expiresAt: number } | undefined;
  let clientSecret: string | undefined;

  const token = async (): Promise<string> => {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    if (!clientSecret) {
      const cognito = new CognitoIdentityProviderClient({});
      const res = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: config.userPoolId, ClientId: config.clientId }));
      clientSecret = res.UserPoolClient?.ClientSecret;
      if (!clientSecret) throw new Error('cognito client has no secret');
    }
    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${config.clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(config.scope ?? 'gateway/invoke')}`,
    });
    if (!res.ok) throw new Error(`cognito token endpoint: ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cached.token;
  };

  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    const res = await fetch(config.gatewayUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`);
    const data = text.includes('data:') ? (text.split('\n').filter((l) => l.startsWith('data:')).pop() ?? '').slice(5) : text;
    const parsed = JSON.parse(data) as { result?: T; error?: { message?: string } };
    if (parsed.error) throw new Error(`gateway rpc error: ${parsed.error.message}`);
    return parsed.result as T;
  };

  return {
    async callTool(name, args) {
      const result = await rpc<{ isError?: boolean; content?: Array<{ text?: string }> }>('tools/call', { name, arguments: args });
      const content = result?.content?.[0]?.text ?? '';
      if (result?.isError) throw new Error(`tool ${name} failed: ${content.slice(0, 300)}`);
      return content;
    },
    async listTools() {
      const tools: GatewayTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await rpc<{ tools?: GatewayTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
        tools.push(...(page?.tools ?? []));
        cursor = page?.nextCursor;
      } while (cursor);
      return tools;
    },
  };
}
