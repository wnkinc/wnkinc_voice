import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/store.js';
import { TenantConfigSchema } from '../src/types.js';

const minimal = { tenantId: 't1', phoneNumber: '+15555550100', businessName: 'T1' };

describe('TenantConfigSchema.products', () => {
  it('defaults every service to off (fail closed)', () => {
    const t = TenantConfigSchema.parse(minimal);
    expect(t.products).toEqual({ emailResponder: { enabled: false }, assistant: { enabled: false }, browser: { enabled: false } });
  });

  it('fills defaults inside a partially specified service', () => {
    const t = TenantConfigSchema.parse({ ...minimal, products: { emailResponder: { enabled: true } } });
    expect(t.products.emailResponder).toEqual({ enabled: true });
    expect(t.products.assistant.enabled).toBe(false);
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
    expect(store.people.get('telegram:7')).toEqual({ channelId: 'telegram:7', tenantId: 't1', tenantPhone: '+15555550100', name: 'Sam', role: 'employee' });

    await store.syncPeople(TenantConfigSchema.parse({ ...minimal, people: [{ name: 'Wes', role: 'owner', telegramId: 42 }] }));
    expect(store.people.get('telegram:7')).toBeUndefined();
    expect(store.people.get('sms:+15555550111')).toBeUndefined();
    expect(store.people.get('telegram:42')).toBeDefined();
  });
  it('rejects a person without a name or with a bad role', () => {
    expect(() => TenantConfigSchema.parse({ ...minimal, people: [{ name: '', role: 'owner' }] })).toThrow();
    expect(() => TenantConfigSchema.parse({ ...minimal, people: [{ name: 'X', role: 'boss' }] })).toThrow();
  });
});
