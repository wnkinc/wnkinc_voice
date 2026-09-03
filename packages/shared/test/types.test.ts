import { describe, expect, it } from 'vitest';
import { ownerUserId } from '../src/google-oauth.js';
import { memoryStore } from '../src/store.js';
import { requireTenant } from '../src/tenant.js';
import { TenantConfigSchema } from '../src/types.js';

const minimal = { tenantId: 't1', phoneNumber: '+15555550100', businessName: 'T1' };

describe('TenantConfigSchema.products', () => {
  it('defaults every service to off (fail closed)', () => {
    const t = TenantConfigSchema.parse(minimal);
    expect(t.products).toEqual({ emailResponder: { enabled: false, via: 'vault' }, backOffice: { enabled: false }, assistant: { enabled: false }, linkedin: { enabled: false } });
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

describe('people and the People index', () => {
  it('defaults to nobody', () => {
    expect(TenantConfigSchema.parse(minimal).people).toEqual([]);
  });
  it('mirrors each channel identity into one index row and drops the ones removed', async () => {
    const store = memoryStore([]);
    const t = TenantConfigSchema.parse({ ...minimal, people: [
      { name: 'Wes', role: 'owner', telegramId: 42, phone: '+15555550111' },
      { name: 'Sam', role: 'employee', telegramId: 7 },
    ] });
    const rows = await store.syncPeople(t);
    expect(rows.map((r) => r.channelId).sort()).toEqual(['sms:+15555550111', 'telegram:42', 'telegram:7']);
    expect(await store.getPerson('telegram:7')).toEqual({ channelId: 'telegram:7', tenantId: 't1', tenantPhone: '+15555550100', name: 'Sam', role: 'employee' });

    await store.syncPeople(TenantConfigSchema.parse({ ...minimal, people: [{ name: 'Wes', role: 'owner', telegramId: 42 }] }));
    expect(await store.getPerson('telegram:7')).toBeUndefined();
    expect(await store.getPerson('sms:+15555550111')).toBeUndefined();
    expect(await store.getPerson('telegram:42')).toBeDefined();
  });
  it('rejects a person without a name or with a bad role', () => {
    expect(() => TenantConfigSchema.parse({ ...minimal, people: [{ name: '', role: 'owner' }] })).toThrow();
    expect(() => TenantConfigSchema.parse({ ...minimal, people: [{ name: 'X', role: 'boss' }] })).toThrow();
  });
});
