import { describe, expect, it, vi } from 'vitest';
import { composeNotification, createNotifierHandler, type NotifierEvent } from '../src/notifier.js';
import { memoryStore } from '@wnk/shared';
import { TenantConfigSchema } from '@wnk/shared';
import { silentLog, TENANT } from './helpers.js';

const lead: NotifierEvent = {
  'detail-type': 'lead.recorded',
  detail: {
    tenantId: 'acme', tenantPhoneNumber: '+15555550100', callId: 'call_1',
    lead: { tenantId: 'acme', sk: 'x', leadId: 'L1', callId: 'call_1', createdAt: 'now', callerName: 'Sam', phone: '+15555550111', reason: 'leak' },
  },
} as NotifierEvent;

const notify: NotifierEvent = {
  'detail-type': 'owner.notify',
  detail: { tenantId: 'acme', tenantPhoneNumber: '+15555550100', callId: 'call_2', summary: 'Burst pipe', urgency: 'urgent', callerPhone: '+15555550123' },
} as NotifierEvent;

describe('notifier', () => {
  it('composes lead emails without SMS', () => {
    const n = composeNotification(lead, TenantConfigSchema.parse(TENANT));
    expect(n.subject).toContain('New lead: Sam');
    expect(n.text).toContain('+15555550111');
    expect(n.sms).toBeUndefined();
  });
  it('sends email + SMS for owner.notify and only email for leads', async () => {
    const sendEmail = vi.fn(async () => {});
    const sendSms = vi.fn(async () => {});
    const handler = createNotifierHandler({ store: () => memoryStore([TENANT]), sendEmail, sendSms, log: silentLog });
    await handler(lead);
    expect(sendEmail).toHaveBeenCalledWith('owner@example.com', expect.stringContaining('New lead'), expect.any(String));
    expect(sendSms).not.toHaveBeenCalled();
    await handler(notify);
    expect(sendSms).toHaveBeenCalledWith('+15555550199', expect.stringContaining('URGENT'));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
  it('throws only when every channel fails', async () => {
    const handler = createNotifierHandler({
      store: () => memoryStore([TENANT]),
      sendEmail: vi.fn(async () => { throw new Error('ses down'); }),
      sendSms: vi.fn(async () => {}),
      log: silentLog,
    });
    await expect(handler(notify)).resolves.toBeUndefined();
    await expect(handler(lead)).rejects.toThrow('all notification channels failed');
  });
});
