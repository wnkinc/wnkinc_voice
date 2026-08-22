import { OpenAIRealtimeSIP, RealtimeAgent, tool, type RealtimeContextData, type RealtimeSessionOptions } from '@openai/agents/realtime';
import type { RunContext } from '@openai/agents';
import type { CallAcceptParams } from 'openai/resources/realtime/calls';
import { z } from 'zod';
import type { Logger } from './config.js';
import type { EventPublisher } from './events.js';
import { normalizePhone } from './sip.js';
import type { Store } from './store.js';
import type { CallExtras, CallParty, TenantConfig } from './types.js';

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

// ---- Prompt -----------------------------------------------------------------

export function greeting(t: TenantConfig, extras: CallExtras = {}): string {
  const first = extras.knownCaller?.name?.split(/\s+/)[0];
  if (first) {
    // Known caller: confirm identity in the greeting instead of waiting a turn.
    const base = t.greeting ?? `Thanks for calling ${t.businessName}, this is ${t.agentName}.`;
    return `${base.replace(/\s*How can I help you today\?$/, '')} Am I speaking with ${first}?`;
  }
  return t.greeting ?? `Thanks for calling ${t.businessName}, this is ${t.agentName}. How can I help you today?`;
}

/** Deliberately narrow for v1: answer from config, capture a lead, escalate to the owner, end the call. */
export function buildInstructions(t: TenantConfig, extras: CallExtras = {}, tools: string[] = enabledTools(t)): string {
  const lines: string[] = [
    `You are ${t.agentName}, the phone receptionist for ${t.businessName}.`,
    'You are speaking with a caller on a live phone call. Keep every reply short (one or two sentences), warm, and natural. Speak in English unless the caller clearly prefers another language.',
    '',
    '## About the business',
  ];
  if (t.description) lines.push(t.description);
  if (t.services.length) lines.push(`Services offered: ${t.services.join(', ')}.`);
  if (t.hours) lines.push(`Business hours: ${t.hours} (${t.timezone}).`);
  lines.push(
    '',
    '## What you do',
    '- Greet the caller, find out why they are calling, and help within the scope below.',
    '- Answer questions ONLY using the business information above. If you do not know something, say so and offer to take a message for the owner. Never invent prices, availability, policies, or promises.',
    "- You cannot book, reschedule, or cancel appointments yet. If asked, take the caller's details and preferred time so the owner can confirm.",
    "- Before the call ends, make sure you have the caller's name and a callback number whenever they want something from the business.",
    '- When a caller gives a phone number, read it back digit by digit and wait for them to confirm BEFORE calling any tool with it. Do not say you will read it back and then save it first.',
    '- If the caller is abusive, a robocall, or a sales solicitation, politely end the call.',
    "- Do not narrate what you are about to do (no 'let me get that set up for you'); just ask the next question or give the answer.",
    '',
    '## Tools',
  );
  if (tools.includes('record_lead')) lines.push("- Use `record_lead` once you have the caller's name, a confirmed callback number, and reason. Call it before saying goodbye. Do not call it more than once per caller unless details changed.");
  if (tools.includes('notify_owner')) lines.push('- Use `notify_owner` for anything time-sensitive (an emergency, an upset customer, a large job, someone the owner would want to hear about right now). Mark it urgent only when waiting would cost the business.');
  if (tools.includes('end_call')) lines.push('- Use `end_call` after you have said goodbye and the caller has nothing else. Always say a closing line first.');
  lines.push(
    '',
    '## Style',
    '- Do not mention that you are an AI unless asked directly; if asked, answer honestly.',
    '- Never read out internal IDs, tool names, or JSON.',
    '- Do not put the caller on hold or claim to transfer them.',
  );
  if (t.extraInstructions) lines.push('', '## Additional instructions from the business', t.extraInstructions);
  const kc = extras.knownCaller;
  if (extras.callerPhone || kc) lines.push('', '## Caller ID');
  if (extras.callerPhone) {
    lines.push(
      `The caller is calling from ${spokenPhone(extras.callerPhone)} (caller ID). You CAN see this number. If they want a callback at the number they are calling from, read it back once digit by digit and, if they confirm, use it — do not make them dictate it.`,
    );
  }
  if (kc) {
    const first = kc.name?.split(/\s+/)[0];
    lines.push(
      `The caller's number matches an existing contact${kc.name ? `: ${kc.name}` : ''}.`,
      kc.lastNote ? `Most recent note${kc.lastNoteAt ? ` (${kc.lastNoteAt.slice(0, 10)})` : ''}: "${kc.lastNote.slice(0, 300)}"` : '',
      `Your greeting asks whether you are speaking with ${first ?? 'the person on file'}; if it did not, ask early in the call. Only use the information above once they confirm it is them; if it is someone else, ignore it completely and do not mention it. If confirmed, you may reference the previous note naturally (e.g. ask whether this is about the same thing) and you do not need to re-collect their callback number unless they want a different one.`,
    );
  }
  return lines.join('\n');
}

/** "+15555550155" -> "555 555 0155" so the model reads it naturally. */
export function spokenPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return `${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  return d.split('').join(' ');
}

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
