import type { Store } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * The one way an agent turns a payload's tenant id into a tenant. The id on a
 * Runtime payload was written by our own code (the tools Lambda from the signed
 * webhook's called number, or an operator script), so it is trusted — but it
 * must be present and must name a real tenant. No defaults: an unknown tenant
 * is refused, never mapped to a fallback business.
 */
export async function requireTenant(store: Store, tenantId: string | undefined): Promise<TenantConfig> {
  if (!tenantId) throw new Error('payload has no tenantId; refusing to act for an unknown tenant');
  const tenant = await store.findTenantById(tenantId);
  if (!tenant) throw new Error(`no tenant config for "${tenantId}"`);
  return tenant;
}
