import { describe, expect, it } from 'vitest';
import { decodeBaggage, encodeBaggage, traceContextFromHeaders, traceIdOf, xrayToTraceparent } from '../src/trace.js';

const xray = 'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1;Lineage=abc:0';

describe('trace stitching', () => {
  it('converts an X-Ray header to a W3C traceparent', () => {
    expect(xrayToTraceparent(xray)).toBe('00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01');
    expect(xrayToTraceparent('Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=0')).toBe('00-5759e988bd862e3fe1be46a994272793-0000000000000001-00');
    expect(xrayToTraceparent('garbage')).toBeUndefined();
  });

  it('extracts the same trace id from either header form', () => {
    expect(traceIdOf(xray)).toBe('5759e988bd862e3fe1be46a994272793');
    expect(traceIdOf('00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01')).toBe('5759e988bd862e3fe1be46a994272793');
    expect(traceIdOf(undefined)).toBeUndefined();
  });

  it('round-trips tenant and call ids through baggage', () => {
    const b = encodeBaggage({ tenant_id: 'wnk', call_id: 'rtc_1 2' });
    expect(b).toBe('tenant_id=wnk,call_id=rtc_1%202');
    expect(decodeBaggage(b)).toEqual({ tenant_id: 'wnk', call_id: 'rtc_1 2' });
    expect(encodeBaggage({})).toBeUndefined();
  });

  it('builds an agent trace context from inbound headers', () => {
    expect(traceContextFromHeaders({ traceparent: '00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01', baggage: 'tenant_id=wnk,call_id=c1' }))
      .toEqual({ traceId: '5759e988bd862e3fe1be46a994272793', tenantId: 'wnk', callId: 'c1' });
    expect(traceContextFromHeaders({ 'x-amzn-trace-id': xray })).toEqual({ traceId: '5759e988bd862e3fe1be46a994272793', tenantId: undefined, callId: undefined });
  });
});
