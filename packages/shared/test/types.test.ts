import { describe, expect, it } from 'vitest';
import { ownerUserId } from '../src/google-oauth.js';
import { memoryStore } from '../src/store.js';
import { requireTenant } from '../src/tenant.js';
import { TenantConfigSchema } from '../src/types.js';

const minimal = { tenantId: 't1', phoneNumber: '+15555550100', businessName: 'T1' };

describe('TenantConfigSchema.products', () => {
  it('defaults every service to off (fail closed)', () => {
    const t = TenantConfigSchema.parse(minimal);
    expect(t.products).toEqual({ emailResponder: { enabled: false, via: 'vault' }, backOffice: { enabled: false } });
  });

  it('fills defaults inside a partially specified service', () => {
    const t = TenantConfigSchema.parse({ ...minimal, products: { emailResponder: { enabled: true } } });
    expect(t.products.emailResponder).toEqual({ enabled: true, via: 'vault' });
    expect(t.products.backOffice.enabled).toBe(false);
  });

  it('rejects an unknown credential broker', () => {
    expect(() => TenantConfigSchema.parse({ ...minimal, products: { emailResponder: { enabled: true, via: 'carrier-pigeon' } } })).toThrow();
  });
});

describe('ownerUserId', () => {
  it('namespaces the vault user by tenant', () => {
    expect(ownerUserId('acme')).toBe('acme_owner');
  });
});

describe('requireTenant', () => {
  const store = memoryStore([{ ...minimal, products: { backOffice: { enabled: true } } }]);

  it('returns the tenant row for a known id', async () => {
    const t = await requireTenant(store, 't1');
    expect(t.products.backOffice.enabled).toBe(true);
  });

  it('refuses a missing id instead of defaulting', async () => {
    await expect(requireTenant(store, undefined)).rejects.toThrow(/no tenantId/);
  });

  it('refuses an unknown id', async () => {
    await expect(requireTenant(store, 'nobody')).rejects.toThrow(/no tenant config/);
  });
});

describe('once-markers', () => {
  it('marks a key once per call and reports duplicates', async () => {
    const store = memoryStore();
    expect(await store.isDone('c1', 'notify:lead:L1')).toBe(false);
    expect(await store.markDone('c1', 'notify:lead:L1')).toBe(true);
    expect(await store.isDone('c1', 'notify:lead:L1')).toBe(true);
    expect(await store.markDone('c1', 'notify:lead:L1')).toBe(false);
    expect(await store.isDone('c2', 'notify:lead:L1')).toBe(false);
  });
});
