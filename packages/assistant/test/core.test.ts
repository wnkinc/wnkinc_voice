import { memoryStore, type GatewayClient } from '@wnk/shared';
import { describe, expect, it } from 'vitest';
import { handleTurn, instructions } from '../src/core.js';
import { TenantConfigSchema } from '@wnk/shared';

const untouchable: GatewayClient = {
  listTools: async () => { throw new Error('gateway must not be called'); },
  callTool: async () => { throw new Error('gateway must not be called'); },
};
const person = { name: 'Wes', role: 'owner' as const };

describe('handleTurn fails closed', () => {
  it('refuses an unknown tenant before touching anything', async () => {
    const store = memoryStore([]);
    await expect(handleTurn({ store, gatewayFor: () => untouchable, model: 'x' }, { tenantId: 'ghost', person, channelId: 'telegram:1', text: 'hi' }))
      .rejects.toThrow(/no tenant config/);
  });
  it('stays silent for a tenant whose assistant is off', async () => {
    const store = memoryStore([{ tenantId: 'acme', phoneNumber: '+15555550100', businessName: 'Acme' }]);
    const out = await handleTurn({ store, gatewayFor: () => untouchable, model: 'x' }, { tenantId: 'acme', person, channelId: 'telegram:1', text: 'hi' });
    expect(out.reply).toBeUndefined();
    expect(out.skipped).toMatch(/not enabled/);
  });
});

describe('instructions', () => {
  it('names the business and the person, and carries memories', () => {
    const t = TenantConfigSchema.parse({ tenantId: 'acme', phoneNumber: '+15555550100', businessName: 'Acme Plumbing', hours: '9-5' });
    const text = instructions(t, person, ['Prefers texts over calls']);
    expect(text).toContain('Acme Plumbing');
    expect(text).toContain('Wes (owner)');
    expect(text).toContain('Hours: 9-5');
    expect(text).toContain('- Prefers texts over calls');
  });
});
