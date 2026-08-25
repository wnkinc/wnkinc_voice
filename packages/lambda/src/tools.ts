/**
 * Gateway Lambda target: the voice tools as shared platform tools.
 *
 * The Gateway invokes this function with the tool's arguments as the event and
 * the tool name in the Lambda client context (bedrockAgentCoreToolName, as
 * "<target>___<tool>"). Tenant context (tenant_id, tenant_phone, call_id,
 * caller_phone) arrives as explicit arguments — callers inject it; the model
 * never supplies it.
 */
import type { Context } from 'aws-lambda';
import { createLogger, dynamoStore, eventBridgePublisher, normalizePhone } from '@wnk/shared';

const log = createLogger({ fn: 'gateway-tools' });
const store = dynamoStore();
const events = eventBridgePublisher();

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
      await events.publish({
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
      await events.publish({
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
    default:
      throw new Error(`unknown tool: ${toolName}`);
  }
}
