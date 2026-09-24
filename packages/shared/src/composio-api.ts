/**
 * Composio's HTTP API, the one client. Composio is the SaaS credential
 * broker: a tenant's Gmail, HubSpot or Facebook token lives in Composio's
 * vault under our tenant id, so every call here names the tenant (user_id =
 * tenantId), and the tenant is an argument the caller passes from the row it
 * resolved, never something a model or a caller names. `version` pins a
 * toolkit release (the REST API runs a toolkit's oldest release when none is
 * named, and Facebook's cannot post to a Page). A `signal` gives a call a
 * deadline, for the call path where a slow lookup must lose the race and
 * never the call.
 *
 * Used by the worker's activities and by accept. The consent scripts use the
 * SDK instead (composio.ts).
 */
export const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1/';

export interface ComposioResult { successful?: boolean; data?: Record<string, any>; error?: unknown }
export interface ComposioAccount { id: string; toolkit: string }

export interface ComposioApi {
  /** Run a tool as the tenant. */
  executeTool(tenantId: string, slug: string, args: Record<string, unknown>, opts?: { version?: string; signal?: AbortSignal }): Promise<ComposioResult>;
  /** The tenant's ACTIVE connected accounts, for one toolkit or all. */
  accounts(tenantId: string, opts?: { toolkit?: string; signal?: AbortSignal }): Promise<ComposioAccount[]>;
  /**
   * A Tool Router session for the tenant: an MCP URL over exactly the toolkits
   * and tools given, the tenant id as Composio's user id, no connection-management
   * or code-sandbox helpers. The URL is called with the project key as bearer
   * (Composio requires it), so whoever calls it must hold the key: the model
   * activity does, per turn. `timezone` shapes the dates the server's own hints use.
   */
  mcpSession(tenantId: string, tools: Record<string, string[]>, timezone?: string, signal?: AbortSignal): Promise<string>;
  /** The toolkit's own REST API on one of the tenant's accounts (`accountId` from `accounts`), for what no tool covers. */
  proxy(tenantId: string, accountId: string, method: 'GET' | 'POST', endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ComposioResult>;
}

/** The client over a way to get the project API key (read once, from the platform secret). */
export function composioApi(apiKey: () => Promise<string>): ComposioApi {
  const call = async (path: string, init: RequestInit & { signal?: AbortSignal }, what: string) => {
    const res = await fetch(`${COMPOSIO_API}${path}`, { ...init, headers: { 'x-api-key': await apiKey(), 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`Composio ${what}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  return {
    async executeTool(tenantId, slug, args, opts = {}) {
      if (!tenantId) throw new Error('executeTool: no tenant');
      return await call(`tools/execute/${slug}`, { method: 'POST', body: JSON.stringify({ user_id: tenantId, arguments: args, ...(opts.version ? { version: opts.version } : {}) }), signal: opts.signal }, slug) as ComposioResult;
    },
    async accounts(tenantId, opts = {}) {
      if (!tenantId) throw new Error('composioAccounts: no tenant');
      const q = new URLSearchParams({ user_ids: tenantId, statuses: 'ACTIVE', ...(opts.toolkit ? { toolkit_slugs: opts.toolkit } : {}) });
      const body = await call(`connected_accounts?${q}`, { signal: opts.signal }, 'connected_accounts') as { items?: { id: string; toolkit?: { slug?: string } }[] };
      return (body.items ?? []).map((i) => ({ id: i.id, toolkit: i.toolkit?.slug ?? '' }));
    },
    async mcpSession(tenantId, tools, timezone, signal) {
      const toolkits = Object.keys(tools);
      if (!tenantId || toolkits.length === 0) throw new Error('mcpSession: no tenant or no toolkits');
      const body = await call('tool_router/session', { method: 'POST', signal, body: JSON.stringify({
        user_id: tenantId, toolkits: { enable: toolkits }, tools: Object.fromEntries(toolkits.map((t) => [t, { enable: tools[t] }])),
        manage_connections: { enable: false }, workbench: { enable: false }, preload: { tools: toolkits.flatMap((t) => tools[t]!) },
        ...(timezone ? { experimental: { assistive_prompt_config: { user_timezone: timezone } } } : {}),
      }) }, 'tool router session') as { mcp?: { url?: string } };
      const url = body.mcp?.url;
      if (!url?.startsWith('https://')) throw new Error('Composio returned no MCP url for the session');
      return url;
    },
    async proxy(tenantId, accountId, method, endpoint, body, signal) {
      if (!tenantId || !accountId) throw new Error('composioProxy: no tenant or account');
      return await call('tools/execute/proxy', { method: 'POST', body: JSON.stringify({ endpoint, method, connected_account_id: accountId, ...(body ? { body } : {}) }), signal }, `proxy ${endpoint}`) as ComposioResult;
    },
  };
}
