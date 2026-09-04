import { createHmac, randomBytes } from 'node:crypto';
import { createLogger } from '@wnk/shared';
import type { TenantConfigInput } from '@wnk/shared';

export const silentLog = createLogger({ test: true });

export const TENANT: TenantConfigInput = {
  tenantId: 'acme',
  phoneNumber: '+15555550100',
  businessName: 'Acme Plumbing',
  services: ['drains'],
  hours: '9-5',
};

export function makeWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/** Standard-Webhooks style signature, matching what OpenAI sends. */
export function signWebhook(secret: string, body: string, opts: { id?: string; timestamp?: number } = {}) {
  const id = opts.id ?? `wh_${randomBytes(8).toString('hex')}`;
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${sig}` };
}

export function incomingCallBody(callId: string, to = '+15555550100', from = '+15555550123'): string {
  return JSON.stringify({
    object: 'event',
    id: `evt_${callId}`,
    type: 'realtime.call.incoming',
    created_at: Math.floor(Date.now() / 1000),
    data: {
      call_id: callId,
      sip_headers: [
        { name: 'From', value: `sip:${from}@sip.example.com` },
        { name: 'To', value: `sip:${to}@sip.api.openai.com` },
        { name: 'Call-ID', value: 'abc-123' },
      ],
    },
  });
}
