import { OpenAIRealtimeSIP, RealtimeAgent, tool, type RealtimeContextData, type RealtimeSessionOptions } from '@openai/agents/realtime';
import type { RunContext } from '@openai/agents';
import type { CallAcceptParams } from 'openai/resources/realtime/calls';
import { z } from 'zod';
import type { Logger } from '@wnk/shared';
import type { EventPublisher } from '@wnk/shared';
import { buildInstructions } from '@wnk/shared';
import { normalizePhone } from './sip.js';
import type { Store } from '@wnk/shared';
import type { CallExtras, CallParty, TenantConfig } from '@wnk/shared';

/** Everything a tool may touch during a call. Passed as the RealtimeSession context. */
export interface CallContext {
  tenant: TenantConfig;
  callId: string;
  party: CallParty;
  store: Store;
  events: EventPublisher;
  log: Logger;
  /** Ask the session to hang up once the current response finishes. */
  requestHangup(): void;
}

type Ctx = RealtimeContextData<CallContext>;

// ---- Tools ------------------------------------------------------------------
// Handlers are plain functions (easy to unit test); `tool()` wraps them for the SDK,
// which validates arguments against the zod schema and runs the function-call loop.

export const RecordLeadArgs = z.object({
  caller_name: z.string().min(1).describe("The caller's name as they gave it"),
  phone: z.string().optional().describe('Callback number in digits, e.g. 5555550123. Omit if the caller declined.'),
  reason: z.string().min(1).describe('One or two sentences on why they called / what they need'),
  preferred_callback_time: z.string().optional().describe('When they would like to be contacted, in their words'),
  notes: z.string().optional().describe('Anything else useful for the owner'),
});
export const NotifyOwnerArgs = z.object({
  summary: z.string().min(1).describe('Two or three sentences the owner should read: who called, what they need, how to reach them'),
  urgency: z.enum(['normal', 'urgent']).default('normal').describe('urgent = the owner should act within minutes'),
});
export const EndCallArgs = z.object({
  reason: z.enum(['completed', 'caller_requested', 'spam', 'abusive', 'no_response']).default('completed'),
});

// The tools run in-process: each is one write or one publish, and the tenant
// comes from the call context the webhook built from the signed called
// number — the model never supplies it. Everything multi-step (email, owner
// notification, CRM sync) is a consumer of the events these publish.
export const handlers = {
  async record_lead(args: z.infer<typeof RecordLeadArgs>, ctx: CallContext) {
    const phone = normalizePhone(args.phone) ?? ctx.party.from;
    const lead = await ctx.store.createLead({
      tenantId: ctx.tenant.tenantId,
      callId: ctx.callId,
      callerName: args.caller_name,
      phone,
      reason: args.reason,
      preferredCallbackTime: args.preferred_callback_time,
      notes: args.notes,
    });
    await ctx.events.publish({ type: 'lead.recorded', tenantId: ctx.tenant.tenantId, tenantPhoneNumber: ctx.tenant.phoneNumber, callId: ctx.callId, lead });
    ctx.log.info('lead recorded', { leadId: lead.leadId });
    return { ok: true, lead_id: lead.leadId, phone_saved: phone ?? null };
  },
  async notify_owner(args: z.infer<typeof NotifyOwnerArgs>, ctx: CallContext) {
    await ctx.events.publish({
      type: 'owner.notify',
      tenantId: ctx.tenant.tenantId,
      tenantPhoneNumber: ctx.tenant.phoneNumber,
      callId: ctx.callId,
      summary: args.summary,
      urgency: args.urgency,
      callerPhone: ctx.party.from,
    });
    ctx.log.info('owner notified', { urgency: args.urgency });
    return { ok: true, delivered: 'queued' };
  },
  async end_call(args: z.infer<typeof EndCallArgs>, ctx: CallContext) {
    ctx.log.info('end_call requested', { reason: args.reason });
    ctx.requestHangup();
    return { ok: true };
  },
};

function ctxOf(rc?: RunContext<Ctx>): CallContext {
  if (!rc) throw new Error('tool called without a run context');
  return rc.context;
}

export const TOOLS = {
  record_lead: tool<typeof RecordLeadArgs, Ctx>({
    name: 'record_lead',
    description: "Save the caller as a lead for the business owner to follow up with. Call once you know the caller's name, a callback number, and why they called.",
    parameters: RecordLeadArgs,
    execute: async (args, rc) => JSON.stringify(await handlers.record_lead(args, ctxOf(rc))),
  }),
  notify_owner: tool<typeof NotifyOwnerArgs, Ctx>({
    name: 'notify_owner',
    description: 'Send the business owner an immediate notification about this call. Use for urgent or high-value situations; for routine follow-ups use record_lead instead.',
    parameters: NotifyOwnerArgs,
    execute: async (args, rc) => JSON.stringify(await handlers.notify_owner(args, ctxOf(rc))),
  }),
  end_call: tool<typeof EndCallArgs, Ctx>({
    name: 'end_call',
    description: 'Hang up the phone call. Only call this after you have said goodbye.',
    parameters: EndCallArgs,
    execute: async (args, rc) => JSON.stringify(await handlers.end_call(args, ctxOf(rc))),
  }),
};
export type ToolName = keyof typeof TOOLS;

export function enabledTools(tenant: TenantConfig): ToolName[] {
  return tenant.tools.filter((n): n is ToolName => n in TOOLS);
}

// ---- Prompt (moved to @wnk/shared/prompt so the console can render it) -------

export { buildInstructions, greeting, spokenPhone } from '@wnk/shared';

// ---- Agent + session config -------------------------------------------------

export function buildAgent(tenant: TenantConfig, extras: CallExtras = {}): RealtimeAgent<CallContext> {
  return new RealtimeAgent<CallContext>({
    name: tenant.agentName,
    instructions: buildInstructions(tenant, extras),
    voice: tenant.voice,
    tools: enabledTools(tenant).map((n) => TOOLS[n]),
  });
}

/** Shared by accept (webhook) and the live session (worker) so both sides agree. */
export function sessionOptions(tenant: TenantConfig): Partial<RealtimeSessionOptions<CallContext>> {
  return {
    model: tenant.model,
    config: {
      outputModalities: ['audio'],
      audio: {
        input: {
          noiseReduction: { type: 'far_field' },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turnDetection: { type: 'semantic_vad', interruptResponse: true },
        },
        output: { voice: tenant.voice },
      },
    },
  };
}

/** Body for POST /v1/realtime/calls/{id}/accept, derived from the agent like OpenAI's example does. */
export async function buildAcceptConfig(tenant: TenantConfig, extras: CallExtras = {}): Promise<CallAcceptParams> {
  const payload = await OpenAIRealtimeSIP.buildInitialConfig(buildAgent(tenant, extras), sessionOptions(tenant));
  return payload as CallAcceptParams;
}
