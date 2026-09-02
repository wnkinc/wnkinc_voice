/**
 * Trace stitching across the seams AWS doesn't stitch for us.
 *
 * X-Ray follows a request Lambda -> Lambda on its own, but the trace header
 * has to be carried by hand through an SQS message, an EventBridge event, and
 * an InvokeAgentRuntime call. These helpers read the current Lambda trace and
 * express it in the form each hop wants (X-Ray header, W3C traceparent, and
 * W3C baggage carrying tenant_id + call_id so every span and log line on the
 * far side can name the tenant and the call).
 */

/** The X-Ray header the Lambda runtime sets for the current invocation, if any. */
export function currentXrayHeader(): string | undefined {
  const h = process.env._X_AMZN_TRACE_ID;
  return h && h.includes('Root=') ? h : undefined;
}

/** `Root=1-<epoch8>-<24hex>;Parent=<16hex>;Sampled=1` -> W3C `00-<32hex>-<16hex>-01`. */
export function xrayToTraceparent(xray: string): string | undefined {
  const root = /Root=1-([0-9a-f]{8})-([0-9a-f]{24})/.exec(xray);
  if (!root) return undefined;
  const parent = /Parent=([0-9a-f]{16})/.exec(xray)?.[1] ?? '0000000000000001';
  const sampled = /Sampled=1/.test(xray) ? '01' : '00';
  return `00-${root[1]}${root[2]}-${parent}-${sampled}`;
}

/** The 32-hex trace id from either header form; what log lines should carry. */
export function traceIdOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const w3c = /^00-([0-9a-f]{32})-/.exec(header);
  if (w3c) return w3c[1];
  const root = /Root=1-([0-9a-f]{8})-([0-9a-f]{24})/.exec(header);
  return root ? `${root[1]}${root[2]}` : undefined;
}

export interface TraceBaggage {
  tenant_id?: string;
  call_id?: string;
}

/** W3C baggage: `tenant_id=wnk,call_id=rtc_123`. */
export function encodeBaggage(b: TraceBaggage): string | undefined {
  const parts = Object.entries(b).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? parts.join(',') : undefined;
}

export function decodeBaggage(header: string | undefined): TraceBaggage {
  const out: TraceBaggage = {};
  for (const part of (header ?? '').split(',')) {
    const [k, v] = part.split('=');
    if (k?.trim() === 'tenant_id' && v) out.tenant_id = decodeURIComponent(v.trim());
    if (k?.trim() === 'call_id' && v) out.call_id = decodeURIComponent(v.trim());
  }
  return out;
}

/** What a Runtime agent learns about the request from its inbound headers. */
export interface TraceContext {
  traceId?: string;
  tenantId?: string;
  callId?: string;
}

export function traceContextFromHeaders(headers: Record<string, string | string[] | undefined>): TraceContext {
  const one = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  const baggage = decodeBaggage(one('baggage'));
  return {
    traceId: traceIdOf(one('traceparent')) ?? traceIdOf(one('x-amzn-trace-id')),
    tenantId: baggage.tenant_id,
    callId: baggage.call_id,
  };
}
