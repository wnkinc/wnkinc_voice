import { createHash } from 'node:crypto';
import type { EventBridgeEvent } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { createLogger, env, type Logger } from '@wnk/shared';
import { dynamoStore, type Store } from '@wnk/shared';
import type { TenantConfig, VoiceEvent } from '@wnk/shared';

type Detail<T extends VoiceEvent['type']> = Omit<Extract<VoiceEvent, { type: T }>, 'type'>;
export type NotifierEvent =
  | EventBridgeEvent<'lead.recorded', Detail<'lead.recorded'>>
  | EventBridgeEvent<'owner.notify', Detail<'owner.notify'>>;

export interface NotifierDeps {
  store: () => Store;
  sendEmail: (to: string, subject: string, text: string) => Promise<void>;
  sendSms: (to: string, text: string) => Promise<void>;
  log?: Logger;
}

export interface Notification {
  subject: string;
  text: string;
  sms?: string; // only set when an SMS should go out
}

export function composeNotification(event: NotifierEvent, tenant: TenantConfig): Notification {
  if (event['detail-type'] === 'lead.recorded') {
    const { lead } = event.detail;
    const lines = [
      `New lead from the ${tenant.businessName} phone line`,
      '',
      `Name: ${lead.callerName}`,
      `Phone: ${lead.phone ?? '(not provided)'}`,
      `Reason: ${lead.reason}`,
      lead.preferredCallbackTime ? `Preferred callback: ${lead.preferredCallbackTime}` : undefined,
      lead.notes ? `Notes: ${lead.notes}` : undefined,
      '',
      `Call ID: ${event.detail.callId}`,
    ].filter((l): l is string => l !== undefined);
    return { subject: `[${tenant.businessName}] New lead: ${lead.callerName}`, text: lines.join('\n') };
  }
  const d = event.detail;
  const prefix = d.urgency === 'urgent' ? 'URGENT' : 'Heads up';
  return {
    subject: `[${tenant.businessName}] ${prefix}: ${d.summary.slice(0, 60)}`,
    text: [`${prefix} from the ${tenant.businessName} phone line:`, '', d.summary, d.callerPhone ? `\nCaller: ${d.callerPhone}` : '', `\nCall ID: ${d.callId}`].join('\n'),
    sms: `${prefix} (${tenant.businessName}): ${d.summary}${d.callerPhone ? ` Caller: ${d.callerPhone}` : ''}`.slice(0, 640),
  };
}

/** Once-key: a lead notifies once per lead; an owner alert once per distinct summary in a call. */
export function notificationKey(event: NotifierEvent): string {
  if (event['detail-type'] === 'lead.recorded') return `notify:lead:${event.detail.lead.leadId}`;
  const d = event.detail;
  return `notify:owner:${createHash('sha256').update(`${d.urgency}|${d.summary}`).digest('hex').slice(0, 12)}`;
}

/** EventBridge → email/SMS. Replace or augment with a Temporal workflow starter later. */
export function createNotifierHandler(deps: NotifierDeps) {
  const baseLog = deps.log ?? createLogger({ fn: 'notifier' });
  return async (event: NotifierEvent): Promise<void> => {
    const log = baseLog.child({ callId: event.detail.callId, eventType: event['detail-type'] });
    const store = deps.store();
    const key = notificationKey(event);
    if (await store.isDone(event.detail.callId, key)) {
      log.info('already notified; duplicate delivery ignored', { key });
      return;
    }
    const tenant = await store.getTenant(event.detail.tenantPhoneNumber);
    if (!tenant) {
      log.error('tenant not found', { tenantPhoneNumber: event.detail.tenantPhoneNumber });
      return;
    }
    const n = composeNotification(event, tenant);
    const { email, sms } = tenant.notifications;
    const attempts: Array<{ channel: 'email' | 'sms'; run: () => Promise<void> }> = [];
    if (email) attempts.push({ channel: 'email', run: () => deps.sendEmail(email, n.subject, n.text) });
    if (sms && n.sms) attempts.push({ channel: 'sms', run: () => deps.sendSms(sms, n.sms!) });
    if (!attempts.length) {
      log.warn('nothing to send: tenant has no matching notification channel');
      return;
    }
    const results = await Promise.allSettled(attempts.map((a) => a.run()));
    results.forEach((r, i) => { if (r.status === 'rejected') log.error(`${attempts[i]!.channel} failed`, { err: r.reason }); });
    if (results.every((r) => r.status === 'rejected')) throw new Error('all notification channels failed');
    await store.markDone(event.detail.callId, key);
    log.info('notification sent', { channels: attempts.map((a) => a.channel) });
  };
}

export const handler = createNotifierHandler({
  store: dynamoStore,
  sendEmail: (() => {
    const ses = new SESClient({});
    return async (to, subject, text) => {
      if (!env.sesFromEmail) throw new Error('SES_FROM_EMAIL not set');
      await ses.send(new SendEmailCommand({ Source: env.sesFromEmail, Destination: { ToAddresses: [to] }, Message: { Subject: { Data: subject }, Body: { Text: { Data: text } } } }));
    };
  })(),
  sendSms: (() => {
    const sns = new SNSClient({});
    return async (to, text) => { await sns.send(new PublishCommand({ PhoneNumber: to, Message: text })); };
  })(),
});
