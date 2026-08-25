import type { EventBridgeEvent } from 'aws-lambda';
import { createLogger, getCrmSecret, type Logger } from '@wnk/shared';
import { hubspotAdapter, nextBusinessMorning, type CrmAdapter } from './hubspot.js';
import { dynamoStore, type Store } from '@wnk/shared';
import type { TenantConfig, VoiceEvent } from '@wnk/shared';

type Detail<T extends VoiceEvent['type']> = Omit<Extract<VoiceEvent, { type: T }>, 'type'>;
export type CrmSyncEvent =
  | EventBridgeEvent<'lead.recorded', Detail<'lead.recorded'>>
  | EventBridgeEvent<'call.ended', Detail<'call.ended'>>;

export interface CrmSyncDeps {
  store: () => Store;
  /** Resolve the tenant's CRM, or undefined if it has none configured. */
  crmFor: (tenant: TenantConfig) => Promise<CrmAdapter | undefined>;
  log?: Logger;
  now?: () => Date;
}

export function splitName(full: string): { firstName?: string; lastName?: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(' ') : undefined };
}

/**
 * EventBridge → CRM. lead.recorded: upsert contact + note + follow-up task.
 * call.ended: transcript note on the contact (if the caller is a contact).
 */
export function createCrmSyncHandler(deps: CrmSyncDeps) {
  const baseLog = deps.log ?? createLogger({ fn: 'crm-sync' });
  const now = deps.now ?? (() => new Date());

  return async (event: CrmSyncEvent): Promise<void> => {
    const log = baseLog.child({ callId: event.detail.callId, eventType: event['detail-type'] });
    const tenant = await deps.store().getTenant(event.detail.tenantPhoneNumber);
    if (!tenant?.crm) {
      log.debug('tenant has no CRM; skipping');
      return;
    }
    const crm = await deps.crmFor(tenant);
    if (!crm) {
      log.warn('tenant has crm configured but no credentials');
      return;
    }

    if (event['detail-type'] === 'lead.recorded') {
      const { lead, callId } = event.detail;
      if (!lead.phone) {
        log.warn('lead has no phone; cannot create contact');
        return;
      }
      const contact = await crm.upsertContact({ phone: lead.phone, ...splitName(lead.callerName) });
      const body = [
        `Phone lead via receptionist (${tenant.businessName} line)`,
        '',
        `Reason: ${lead.reason}`,
        lead.preferredCallbackTime ? `Preferred callback: ${lead.preferredCallbackTime}` : undefined,
        lead.notes ? `Notes: ${lead.notes}` : undefined,
        '',
        `Call ID: ${callId}`,
      ].filter((l): l is string => l !== undefined).join('\n');
      await crm.addNote(contact.id, body, now());
      await crm.addTask(contact.id, {
        subject: `Follow up with ${lead.callerName} (${lead.phone})`,
        body: `${lead.reason}${lead.preferredCallbackTime ? `\nPreferred: ${lead.preferredCallbackTime}` : ''}`,
        dueAt: nextBusinessMorning(now(), tenant.timezone),
      });
      log.info('lead synced to CRM', { contactId: contact.id });
      return;
    }

    // call.ended
    const { callerPhone, transcript, durationSeconds, status, callId } = event.detail;
    if (!callerPhone || !transcript.length) {
      log.info('no caller phone or empty transcript; nothing to log');
      return;
    }
    const contact = await crm.findContactByPhone(callerPhone);
    if (!contact) {
      log.info('caller is not a contact; not logging call');
      return;
    }
    const lines = transcript
      .filter((t) => t.role !== 'tool')
      .map((t) => `${t.role === 'user' ? 'Caller' : 'Agent'}: ${t.text}`);
    const body = [
      `Call to ${tenant.businessName} line — ${Math.round(durationSeconds / 60)} min, ${status}`,
      '',
      ...lines,
      '',
      `Call ID: ${callId}`,
    ].join('\n');
    await crm.addNote(contact.id, body.slice(0, 60_000), now());
    log.info('call logged to CRM', { contactId: contact.id, lines: lines.length });
  };
}

const adapters = new Map<string, Promise<CrmAdapter | undefined>>();
/** Production resolver: one HubSpot adapter per tenant, token from Secrets Manager. */
export async function crmForTenant(tenant: TenantConfig): Promise<CrmAdapter | undefined> {
  if (tenant.crm?.type !== 'hubspot') return undefined;
  let p = adapters.get(tenant.tenantId);
  if (!p) {
    p = getCrmSecret(tenant.tenantId).then((s) => (s?.HUBSPOT_TOKEN ? hubspotAdapter(s.HUBSPOT_TOKEN) : undefined));
    adapters.set(tenant.tenantId, p);
    p.catch(() => adapters.delete(tenant.tenantId));
  }
  return p;
}

export const handler = createCrmSyncHandler({ store: dynamoStore, crmFor: crmForTenant });
