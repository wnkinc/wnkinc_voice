/**
 * Gateway REQUEST interceptor: tenant context from the caller's identity.
 *
 * The Gateway has already authenticated the request (JWT inbound auth: an
 * invalid or expired token is a 401 before anything runs here) and hands us
 * the validated bearer token in the headers. We read its `client_id`, map it
 * to the tenant that owns that app client, and write `tenant_id` and
 * `tenant_phone` into the tool arguments — overwriting anything the caller
 * put there. The model never supplies tenant context; the agent never injects
 * it; the Gateway does, from who the caller is.
 *
 * No re-validation of the token: AWS guarantees the signature, expiry, and
 * scope before invoking an interceptor on a JWT-authorized gateway. What we
 * add is attribution: a client with no tenant row is refused (fail closed).
 * The one exception is the admin/test client (PLATFORM_CLIENT_IDS), which
 * passes through unchanged and must name the tenant in its arguments itself.
 *
 * Never log the headers: they carry the bearer token.
 */
import { dynamoStore, type Store } from '@wnk/shared';

interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>;
}

export interface InterceptorEvent {
  interceptorInputVersion?: string;
  mcp?: {
    gatewayRequest?: { headers?: Record<string, string>; body?: McpRequest };
  };
}

export interface InterceptorResult {
  interceptorOutputVersion: '1.0';
  mcp: {
    transformedGatewayRequest?: { body: McpRequest };
    transformedGatewayResponse?: { statusCode: number; body: unknown };
  };
}

export interface TenantIdentity {
  tenantId: string;
  phoneNumber: string;
}

/** `client_id` from a JWT payload. The signature was verified by the Gateway; this only reads. */
export function clientIdFromBearer(authorization: string | undefined): string | undefined {
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
  const payload = token?.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { client_id?: unknown };
    return typeof json.client_id === 'string' ? json.client_id : undefined;
  } catch {
    return undefined;
  }
}

const passThrough = (body: McpRequest): InterceptorResult => ({ interceptorOutputVersion: '1.0', mcp: { transformedGatewayRequest: { body } } });
const deny = (id: McpRequest['id'], message: string): InterceptorResult => ({
  interceptorOutputVersion: '1.0',
  mcp: { transformedGatewayResponse: { statusCode: 403, body: { jsonrpc: '2.0', id: id ?? null, error: { code: -32003, message } } } },
});

/**
 * Pure transform: given the request and a way to attribute a client id to a
 * tenant, return what the Gateway should do. `platformClients` are the
 * admin exception described above.
 */
export async function interceptRequest(
  event: InterceptorEvent,
  lookup: (clientId: string) => Promise<TenantIdentity | undefined>,
  platformClients: ReadonlySet<string> = new Set(),
): Promise<InterceptorResult> {
  const req = event.mcp?.gatewayRequest ?? {};
  const body = req.body ?? {};
  if (body.method !== 'tools/call') return passThrough(body);

  const headers = req.headers ?? {};
  const authorization = headers.authorization ?? headers.Authorization;
  const clientId = clientIdFromBearer(authorization);
  if (!clientId) {
    console.warn(JSON.stringify({ msg: 'tools/call without a readable client_id; refusing', tool: body.params?.name }));
    return deny(body.id, 'caller identity unavailable');
  }

  const tenant = await lookup(clientId);
  if (!tenant) {
    if (platformClients.has(clientId)) {
      console.log(JSON.stringify({ msg: 'admin client; tenant context left to the caller', clientId, tool: body.params?.name }));
      return passThrough(body);
    }
    console.warn(JSON.stringify({ msg: 'no tenant owns this client; refusing', clientId, tool: body.params?.name }));
    return deny(body.id, 'no tenant for caller');
  }

  const params = { ...(body.params ?? {}) };
  params.arguments = { ...(params.arguments ?? {}), tenant_id: tenant.tenantId, tenant_phone: tenant.phoneNumber };
  console.log(JSON.stringify({ msg: 'tenant context injected', tenantId: tenant.tenantId, clientId, tool: params.name }));
  return passThrough({ ...body, params });
}

// ---- Lambda wiring ----------------------------------------------------------

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; tenant: TenantIdentity | undefined }>();

export function cachedLookup(store: Store): (clientId: string) => Promise<TenantIdentity | undefined> {
  return async (clientId) => {
    const hit = cache.get(clientId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.tenant;
    const t = await store.findTenantByClientId(clientId);
    const tenant = t ? { tenantId: t.tenantId, phoneNumber: t.phoneNumber } : undefined;
    cache.set(clientId, { at: Date.now(), tenant });
    return tenant;
  };
}

const store = dynamoStore();
const lookup = cachedLookup(store);
const platformClients = new Set((process.env.PLATFORM_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export async function handler(event: InterceptorEvent): Promise<InterceptorResult> {
  return interceptRequest(event, lookup, platformClients);
}
