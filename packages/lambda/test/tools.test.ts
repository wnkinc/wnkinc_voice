import { memoryStore } from '@wnk/shared';
import { describe, expect, it } from 'vitest';
import { crmForTenantId } from '../src/tools.js';

const base = { tenantId: 'acme', phoneNumber: '+15555550100', businessName: 'Acme' };

describe('crmForTenantId (fail closed)', () => {
  it('refuses an unknown tenant', async () => {
    await expect(crmForTenantId(memoryStore([]), 'ghost')).rejects.toThrow(/no tenant/);
  });
  it('refuses a tenant with no CRM', async () => {
    await expect(crmForTenantId(memoryStore([base]), 'acme')).rejects.toThrow(/no CRM/);
  });
  it('refuses a tenant still on the legacy token path', async () => {
    await expect(crmForTenantId(memoryStore([{ ...base, crm: { type: 'hubspot' } }]), 'acme')).rejects.toThrow(/not connected through Composio/);
  });
  it('returns an adapter for a Composio-connected tenant', async () => {
    const crm = await crmForTenantId(memoryStore([{ ...base, crm: { type: 'hubspot', via: 'composio' } }]), 'acme');
    expect(typeof crm.searchContacts).toBe('function');
  });
});
