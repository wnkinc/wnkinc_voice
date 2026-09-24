import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/store.js';
import { TenantConfigSchema } from '../src/types.js';

const minimal = { tenantId: 't1', phoneNumber: '+15555550100', business: { name: 'T1' } };

describe('TenantConfigSchema service blocks', () => {
  it('defaults every service to off (fail closed)', () => {
    const t = TenantConfigSchema.parse(minimal);
    expect(t.emailResponder).toEqual({ enabled: false });
    expect(t.assistant).toEqual({ enabled: false, tools: [], mcp: {} });
    expect(t.browser).toEqual({ enabled: false });
  });

  it('fills defaults inside a partially specified block', () => {
    const t = TenantConfigSchema.parse({ ...minimal, emailResponder: { enabled: true }, receptionist: { session: { tools: ['end_call'] } } });
    expect(t.emailResponder).toEqual({ enabled: true });
    expect(t.assistant.enabled).toBe(false);
    expect(t.receptionist.session.tools).toEqual(['end_call']);
    expect(t.receptionist.session.audio.output.voice).toBe('marin');
    expect(t.business.timezone).toBe('America/Los_Angeles');
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
