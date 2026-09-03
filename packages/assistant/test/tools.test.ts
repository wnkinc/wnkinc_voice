import { TenantConfigSchema, type GatewayTool } from '@wnk/shared';
import { describe, expect, it } from 'vitest';
import { prepareTool, prepareTools, targetEnabled } from '../src/tools.js';

const base = { tenantId: 'acme', phoneNumber: '+15555550100', businessName: 'Acme' };
const withCrm = TenantConfigSchema.parse({ ...base, crm: { type: 'hubspot', via: 'composio' } });
const legacyCrm = TenantConfigSchema.parse({ ...base, crm: { type: 'hubspot' } });
const noCrm = TenantConfigSchema.parse(base);

const catalog: GatewayTool[] = [
  { name: 'crm___search_contacts', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'voice___record_lead', description: 'Record', inputSchema: { type: 'object', properties: { tenant_id: { type: 'string' }, tenant_phone: { type: 'string' }, caller_name: { type: 'string' } }, required: ['tenant_id', 'caller_name'] } },
];

describe('targetEnabled', () => {
  it('offers a target only when the tenant row turns it on', () => {
    expect(targetEnabled('crm___search_contacts', withCrm)).toBe(true);
    expect(targetEnabled('crm___search_contacts', noCrm)).toBe(false);
    expect(targetEnabled('crm___search_contacts', legacyCrm)).toBe(false);
  });
  it('offers nothing it does not know (fail closed)', () => {
    expect(targetEnabled('voice___record_lead', withCrm)).toBe(false);
    expect(targetEnabled('mystery', withCrm)).toBe(false);
  });
});

describe('prepareTool', () => {
  it('hides tenant context from the model and injects it on the call', () => {
    const p = prepareTool(catalog[1]!, withCrm);
    expect(Object.keys(p.parameters.properties)).toEqual(['caller_name']);
    expect(p.parameters.required).toEqual(['caller_name']);
    expect(p.callArgs({ caller_name: 'Sam', tenant_id: 'evil' })).toEqual({ caller_name: 'Sam', tenant_id: 'acme', tenant_phone: '+15555550100' });
  });
  it('leaves tools without tenant context alone', () => {
    const p = prepareTool(catalog[0]!, withCrm);
    expect(p.parameters.properties).toEqual({ query: { type: 'string' } });
    expect(p.callArgs({ query: 'sam' })).toEqual({ query: 'sam' });
  });
});

describe('prepareTools', () => {
  it('is the catalog filtered by tenant config', () => {
    expect(prepareTools(catalog, withCrm).map((t) => t.name)).toEqual(['crm___search_contacts']);
    expect(prepareTools(catalog, noCrm)).toEqual([]);
  });
});
