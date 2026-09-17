import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createVerifier, verifySignature } from '../src/webhook.js';
import { incomingCallBody, makeWebhookSecret, signWebhook } from './helpers.js';

const secret = makeWebhookSecret();
const req = (body: string, headers: Record<string, string>, base64 = false): APIGatewayProxyEventV2 => ({
  version: '2.0', routeKey: 'POST /openai/webhook', rawPath: '/openai/webhook', rawQueryString: '',
  headers, isBase64Encoded: base64, body: base64 ? Buffer.from(body).toString('base64') : body,
  requestContext: { http: { method: 'POST' } } as APIGatewayProxyEventV2['requestContext'],
});

describe('verifySignature', () => {
  const body = incomingCallBody('rtc_1');
  it('accepts a valid v1 signature', () => {
    expect(verifySignature(secret, body, signWebhook(secret, body))).toBe(true);
  });
  it('accepts when one of several rotated signatures matches', () => {
    const h = signWebhook(secret, body);
    expect(verifySignature(secret, body, { ...h, 'webhook-signature': `v1,AAAA ${h['webhook-signature']}` })).toBe(true);
  });
  it('rejects a wrong secret, a tampered body, and missing headers', () => {
    const h = signWebhook(secret, body);
    expect(verifySignature(makeWebhookSecret(), body, h)).toBe(false);
    expect(verifySignature(secret, body + ' ', h)).toBe(false);
    expect(verifySignature(secret, body, { 'webhook-id': h['webhook-id'] })).toBe(false);
  });
  it('rejects stale timestamps', () => {
    const h = signWebhook(secret, body, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(verifySignature(secret, body, h)).toBe(false);
  });
});

describe('verifier handler', () => {
  it('starts the workflow with the raw body on a valid signature', async () => {
    const start = vi.fn(async () => {});
    const body = incomingCallBody('rtc_2');
    const res = await createVerifier({ secret: async () => secret, start })(req(body, signWebhook(secret, body)));
    expect(res).toMatchObject({ statusCode: 200 });
    expect(start).toHaveBeenCalledWith(body);
  });
  it('handles base64-encoded bodies from API Gateway', async () => {
    const start = vi.fn(async () => {});
    const body = incomingCallBody('rtc_3');
    const res = await createVerifier({ secret: async () => secret, start })(req(body, signWebhook(secret, body), true));
    expect(res).toMatchObject({ statusCode: 200 });
    expect(start).toHaveBeenCalledWith(body);
  });
  it('returns 400 and starts nothing on a bad signature', async () => {
    const start = vi.fn(async () => {});
    const body = incomingCallBody('rtc_4');
    const res = await createVerifier({ secret: async () => makeWebhookSecret(), start })(req(body, signWebhook(secret, body)));
    expect(res).toMatchObject({ statusCode: 400 });
    expect(start).not.toHaveBeenCalled();
  });
});
