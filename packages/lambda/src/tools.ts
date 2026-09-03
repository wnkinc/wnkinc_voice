/**
 * Gateway Lambda target: the platform's tools — voice (record_lead,
 * notify_owner) and CRM (search/get/create contact, add note).
 *
 * The Gateway invokes this function with the tool's arguments as the event and
 * the tool name in the Lambda client context (bedrockAgentCoreToolName, as
 * "<target>___<tool>"). Tenant context (tenant_id, tenant_phone) is written
 * into the arguments by the Gateway's request interceptor from the caller's
 * identity; call context (call_id, caller_phone) by the voice agent. The model
 * never supplies any of it.
 *
 * CRM tools reach HubSpot through Composio with the tenant id as the only
 * credential our code names (composioCrm); a tenant whose row has no CRM
 * gets a refusal, not someone else's CRM.
 */
import type { Context } from 'aws-lambda';
import { createLogger, dynamoStore, eventBridgePublisher, normalizePhone, type CrmAdapter, type CrmContact, type Store } from '@wnk/shared';
import { composioCrm } from '@wnk/shared/composio';

const log = createLogger({ fn: 'gateway-tools' });
const store = dynamoStore();
let publisher: ReturnType<typeof eventBridgePublisher> | undefined;
const events = () => (publisher ??= eventBridgePublisher());

/** The tenant's CRM, by its row — never a default. */
export async function crmForTenantId(s: Store, tenantId: string): Promise<CrmAdapter> {
  const tenant = await s.findTenantById(tenantId);
  if (!tenant) throw new Error(`no tenant "${tenantId}"`);
  if (tenant.crm?.type !== 'hubspot') throw new Error(`tenant "${tenantId}" has no CRM connected`);
  if (tenant.crm.via !== 'composio') throw new Error(`tenant "${tenantId}" CRM is not connected through Composio yet`);
  return composioCrm(tenantId);
}

const publicContact = (c: CrmContact) => ({
  id: c.id,
  name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
  phone: c.phone ?? null,
  email: c.email ?? null,
});

interface ToolContext {
  tenant_id: string;
  tenant_phone: string;
  call_id: string;
  caller_phone?: string;
}

export async function handler(event: Record<string, unknown>, context: Context): Promise<unknown> {
  const custom = (context.clientContext as { custom?: Record<string, string> } | undefined)?.custom ?? {};
  const toolName = (custom.bedrockAgentCoreToolName ?? '').split('___').pop() ?? '';
  const ctx = event as unknown as ToolContext;
  log.info('tool call', { toolName, tenantId: ctx.tenant_id, callId: ctx.call_id });

  switch (toolName) {
    case 'record_lead': {
      const lead = await store.createLead({
        tenantId: ctx.tenant_id,
        callId: ctx.call_id,
        callerName: String(event.caller_name ?? ''),
        phone: normalizePhone(event.phone as string | undefined) ?? ctx.caller_phone,
        reason: String(event.reason ?? ''),
        preferredCallbackTime: event.preferred_callback_time as string | undefined,
        notes: event.notes as string | undefined,
      });
      await events().publish({
        type: 'lead.recorded',
        tenantId: ctx.tenant_id,
        tenantPhoneNumber: ctx.tenant_phone,
        callId: ctx.call_id,
        lead,
      });
      log.info('lead recorded', { leadId: lead.leadId });
      return { ok: true, lead_id: lead.leadId, phone_saved: lead.phone ?? null };
    }
    case 'notify_owner': {
      await events().publish({
        type: 'owner.notify',
        tenantId: ctx.tenant_id,
        tenantPhoneNumber: ctx.tenant_phone,
        callId: ctx.call_id,
        summary: String(event.summary ?? ''),
        urgency: (event.urgency as 'normal' | 'urgent' | undefined) ?? 'normal',
        callerPhone: ctx.caller_phone,
      });
      log.info('owner notified', { urgency: event.urgency });
      return { ok: true, delivered: 'queued' };
    }
    case 'search_contacts': {
      const crm = await crmForTenantId(store, ctx.tenant_id);
      const query = String(event.query ?? '').trim();
      if (!query) return { contacts: [] };
      const byPhone = normalizePhone(query);
      const hits = byPhone ? [await crm.findContactByPhone(byPhone)].filter((c): c is CrmContact => Boolean(c)) : await crm.searchContacts(query, Math.min(Number(event.limit ?? 5) || 5, 20));
      return { contacts: hits.map(publicContact) };
    }
    case 'get_contact': {
      const crm = await crmForTenantId(store, ctx.tenant_id);
      const c = await crm.getContact(String(event.contact_id ?? ''));
      return c ? { contact: publicContact(c), last_note: (await crm.lastNote(c.id).catch(() => undefined)) ?? null } : { contact: null };
    }
    case 'create_contact': {
      const crm = await crmForTenantId(store, ctx.tenant_id);
      const phone = normalizePhone(event.phone as string | undefined);
      if (!phone) throw new Error('create_contact needs a phone number');
      const c = await crm.upsertContact({ phone, firstName: event.first_name as string | undefined, lastName: event.last_name as string | undefined });
      return { contact: publicContact(c) };
    }
    case 'add_note': {
      const crm = await crmForTenantId(store, ctx.tenant_id);
      const contactId = String(event.contact_id ?? '');
      const body = String(event.body ?? '').trim();
      if (!contactId || !body) throw new Error('add_note needs contact_id and body');
      await crm.addNote(contactId, body);
      return { ok: true };
    }
    default:
      throw new Error(`unknown tool: ${toolName}`);
  }
}
