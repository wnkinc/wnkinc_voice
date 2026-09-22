/**
 * Composio's HTTP API for one tenant. The tenant's SaaS credentials live in
 * Composio's vault under our tenant id (user_id = tenantId), so every call
 * names the tenant, and the tenant is an argument the workflow passes from
 * the row it resolved, never something the model or a caller names.
 * `version` pins the toolkit release: without it the REST API runs the
 * toolkit's oldest release, which for Facebook cannot post to a Page.
 */
import { env, secret } from './config.js';

export const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1/';

export interface ComposioResult { successful?: boolean; data?: Record<string, any>; error?: unknown }

export async function executeTool(tenantId: string, slug: string, args: Record<string, unknown>, version?: string): Promise<ComposioResult> {
  if (!tenantId) throw new Error('executeTool: no tenant');
  const key = (await secret(env('COMPOSIO_SECRET_ARN'))).COMPOSIO_API_KEY;
  if (!key) throw new Error('the Composio secret is not filled in');
  const res = await fetch(`${COMPOSIO_API}tools/execute/${slug}`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: tenantId, arguments: args, ...(version ? { version } : {}) }),
  });
  if (!res.ok) throw new Error(`Composio ${slug}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json() as ComposioResult;
}

export interface ComposioAccount { id: string; toolkit: string }

/** The tenant's ACTIVE connected accounts, for one toolkit or all. */
export async function composioAccounts(tenantId: string, toolkit?: string): Promise<ComposioAccount[]> {
  if (!tenantId) throw new Error('composioAccounts: no tenant');
  const key = (await secret(env('COMPOSIO_SECRET_ARN'))).COMPOSIO_API_KEY;
  if (!key) throw new Error('the Composio secret is not filled in');
  const q = new URLSearchParams({ user_ids: tenantId, statuses: 'ACTIVE', ...(toolkit ? { toolkit_slugs: toolkit } : {}) });
  const res = await fetch(`${COMPOSIO_API}connected_accounts?${q}`, { headers: { 'x-api-key': key } });
  if (!res.ok) throw new Error(`Composio connected_accounts: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { items?: { id: string; toolkit?: { slug?: string } }[] };
  return (body.items ?? []).map((i) => ({ id: i.id, toolkit: i.toolkit?.slug ?? '' }));
}

/** The toolkit's own REST API on one of the tenant's accounts (`accountId` from composioAccounts), for what no tool covers. */
export async function composioProxy(tenantId: string, accountId: string, method: 'GET' | 'POST', endpoint: string, body?: Record<string, unknown>): Promise<ComposioResult> {
  if (!tenantId || !accountId) throw new Error('composioProxy: no tenant or account');
  const key = (await secret(env('COMPOSIO_SECRET_ARN'))).COMPOSIO_API_KEY;
  if (!key) throw new Error('the Composio secret is not filled in');
  const res = await fetch(`${COMPOSIO_API}tools/execute/proxy`, {
    method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, method, connected_account_id: accountId, ...(body ? { body } : {}) }),
  });
  if (!res.ok) throw new Error(`Composio proxy ${endpoint}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json() as ComposioResult;
}
