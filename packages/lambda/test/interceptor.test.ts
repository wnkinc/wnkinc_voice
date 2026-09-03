import { describe, expect, it } from 'vitest';
import { clientIdFromBearer, interceptRequest, type InterceptorEvent } from '../src/interceptor.js';

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const tenants: Record<string, { tenantId: string; phoneNumber: string }> = { 'client-wnk': { tenantId: 'wnk', phoneNumber: '+15550001111' } };
const lookup = async (id: string) => tenants[id];

const call = (clientId: string | undefined, args: Record<string, unknown> = { query: 'sam' }): InterceptorEvent => ({
  mcp: {
    gatewayRequest: {
      headers: clientId ? { Authorization: `Bearer ${jwt({ client_id: clientId })}` } : {},
      body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'crm___search', arguments: args } },
    },
  },
});

describe('clientIdFromBearer', () => {
  it('reads client_id from a bearer JWT payload', () => {
    expect(clientIdFromBearer(`Bearer ${jwt({ client_id: 'abc', scope: 'gateway/invoke' })}`)).toBe('abc');
  });
  it('is undefined for anything else', () => {
    expect(clientIdFromBearer(undefined)).toBeUndefined();
    expect(clientIdFromBearer('Basic zzz')).toBeUndefined();
    expect(clientIdFromBearer('Bearer not.a.jwt')).toBeUndefined();
  });
});

describe('interceptRequest', () => {
  it('passes non-call methods through untouched', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const out = await interceptRequest({ mcp: { gatewayRequest: { body } } }, lookup);
    expect(out.mcp.transformedGatewayRequest?.body).toEqual(body);
    expect(out.mcp.transformedGatewayResponse).toBeUndefined();
  });
  it('injects tenant context from the caller identity, overwriting whatever was supplied', async () => {
    const out = await interceptRequest(call('client-wnk', { query: 'sam', tenant_id: 'evil', tenant_phone: '+10000000000' }), lookup);
    expect(out.mcp.transformedGatewayRequest?.body.params?.arguments).toEqual({ query: 'sam', tenant_id: 'wnk', tenant_phone: '+15550001111' });
    expect(out.mcp.transformedGatewayRequest?.body.params?.name).toBe('crm___search');
  });
  it('refuses a caller no tenant owns', async () => {
    const out = await interceptRequest(call('client-stranger'), lookup);
    expect(out.mcp.transformedGatewayResponse?.statusCode).toBe(403);
    expect(out.mcp.transformedGatewayRequest).toBeUndefined();
  });
  it('refuses a call with no readable identity', async () => {
    const out = await interceptRequest(call(undefined), lookup);
    expect(out.mcp.transformedGatewayResponse?.statusCode).toBe(403);
  });
  it('lets a platform client through unchanged during the cutover', async () => {
    const out = await interceptRequest(call('client-voice', { summary: 'x', tenant_id: 'wnk' }), lookup, new Set(['client-voice']));
    expect(out.mcp.transformedGatewayRequest?.body.params?.arguments).toEqual({ summary: 'x', tenant_id: 'wnk' });
  });
});
