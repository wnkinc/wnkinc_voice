import { randomUUID } from 'node:crypto';
import { RealtimeAgent, tool, type RealtimeContextData, type RealtimeSessionOptions } from '@openai/agents/realtime';
import type { RunContext } from '@openai/agents';
import { z } from 'zod';
import type { Logger } from '@wnk/shared';
import type { EventPublisher } from '@wnk/shared';
import { normalizePhone } from '@wnk/shared';
import { dayLabel, dayWindow, openSlots, slotAt, type Busy } from '@wnk/shared';
import { buildInstructions } from './prompt.js';
import type { Store } from '@wnk/shared';
import type { Appointment, CallExtras, CallParty, Lead, TenantConfig } from '@wnk/shared';

/** The one calendar read a call may make: busy intervals, nothing else, for the tenant the call resolved. Given a deadline by whoever builds it. */
export interface CalendarReads {
  busy(tenantId: string, calendarId: string, timeMin: string, timeMax: string): Promise<Busy[]>;
}

/** Everything a tool may touch during a call. Passed as the RealtimeSession context. */
export interface CallContext {
  tenant: TenantConfig;
  callId: string;
  party: CallParty;
  store: Store;
  events: EventPublisher;
  log: Logger;
  /** Absent when the session has no calendar access; the booking tools then answer that booking is unavailable. */
  calendar?: CalendarReads;
  /** Ask the session to hang up once the current response finishes. */
  requestHangup(): void;
  now?: () => Date;
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
export const CheckAvailabilityArgs = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The day the caller asked about, as YYYY-MM-DD in the business's timezone"),
});
export const BookAppointmentArgs = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('The chosen slot\'s `start`, exactly as check_availability listed it'),
  caller_name: z.string().min(1).describe("The caller's name as they gave it"),
  phone: z.string().optional().describe('Callback number in digits, confirmed with the caller. Omit to use the number they are calling from.'),
  email: z.string().email().optional().describe('Only if the caller asked for an email confirmation and spelled the address out'),
  reason: z.string().min(1).describe('One sentence on what the appointment is for'),
});

/** What the booking tools answer when the calendar cannot be used: the model falls back to taking details. */
const NO_BOOKING = { ok: false as const, reason: "Booking is not available right now. Take the caller's name, number, and preferred time so the owner can confirm." };

// The tools run in-process: each is one publish, and the tenant comes from the
// call context the webhook built from the signed called number — the model
// never supplies it. Everything multi-step (email, owner notification, CRM
// sync) is a consumer of the events these publish. The platform keeps no lead
// table: the tenant's CRM holds the lead, and the call row (this tool call,
// plus each consumer's once-marker) is the audit that it got there.
export const handlers = {
  async record_lead(args: z.infer<typeof RecordLeadArgs>, ctx: CallContext) {
    const phone = normalizePhone(args.phone) ?? ctx.party.from;
    const lead: Lead = {
      leadId: randomUUID(),
      createdAt: new Date().toISOString(),
      tenantId: ctx.tenant.tenantId,
      callId: ctx.callId,
      callerName: args.caller_name,
      phone,
      reason: args.reason,
      preferredCallbackTime: args.preferred_callback_time,
      notes: args.notes,
    };
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
  // The calendar reaches the call as busy intervals only, and the model sees
  // the open slots computed from them: nothing another customer's event holds
  // can be read out. The booking itself is a publish; the workflow re-checks
  // the slot, writes the event, and texts the caller.
  async check_availability(args: z.infer<typeof CheckAvailabilityArgs>, ctx: CallContext) {
    const cal = ctx.tenant.calendar;
    if (!cal.enabled || !ctx.calendar) return NO_BOOKING;
    const tz = ctx.tenant.business.timezone;
    let busy: Busy[];
    try {
      const { timeMin, timeMax } = dayWindow(args.date, tz);
      busy = await ctx.calendar.busy(ctx.tenant.tenantId, cal.calendarId, timeMin, timeMax);
    } catch (err) {
      ctx.log.error('free/busy failed', { err, date: args.date });
      return NO_BOOKING;
    }
    const slots = openSlots(args.date, busy, cal, tz, ctx.now?.() ?? new Date());
    ctx.log.info('availability checked', { date: args.date, open: slots.length });
    return { ok: true, day: dayLabel(args.date), slots: slots.map((s) => ({ start: s.local, time: s.label })) };
  },
  async book_appointment(args: z.infer<typeof BookAppointmentArgs>, ctx: CallContext) {
    const cal = ctx.tenant.calendar;
    if (!cal.enabled || !ctx.calendar) return NO_BOOKING;
    const tz = ctx.tenant.business.timezone;
    const slot = slotAt(args.start, cal, tz, ctx.now?.() ?? new Date());
    if (!slot) return { ok: false as const, reason: 'That time is not one that can be booked. Offer a time from check_availability.' };
    const phone = normalizePhone(args.phone) ?? ctx.party.from;
    const appointment: Appointment = {
      tenantId: ctx.tenant.tenantId, appointmentId: randomUUID(), callId: ctx.callId, createdAt: new Date().toISOString(),
      callerName: args.caller_name, phone, email: args.email, reason: args.reason,
      startsAt: slot.startsAt, endsAt: slot.endsAt, local: slot.local, timezone: tz, durationMinutes: cal.slotMinutes,
    };
    await ctx.events.publish({ type: 'appointment.requested', tenantId: ctx.tenant.tenantId, tenantPhoneNumber: ctx.tenant.phoneNumber, callId: ctx.callId, appointment });
    ctx.log.info('appointment requested', { appointmentId: appointment.appointmentId, local: slot.local });
    return { ok: true, appointment_id: appointment.appointmentId, when: `${dayLabel(slot.local.slice(0, 10))} at ${slot.label}`, confirmation: phone ? 'a text will confirm it' : 'none' };
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
  check_availability: tool<typeof CheckAvailabilityArgs, Ctx>({
    name: 'check_availability',
    description: 'The open appointment times on one day. Call it for the day the caller asks about before offering any time; offer only times it returns.',
    parameters: CheckAvailabilityArgs,
    execute: async (args, rc) => JSON.stringify(await handlers.check_availability(args, ctxOf(rc))),
  }),
  book_appointment: tool<typeof BookAppointmentArgs, Ctx>({
    name: 'book_appointment',
    description: "Book the caller into a slot check_availability listed, once they have chosen it and confirmed their name and number. The business texts them a confirmation.",
    parameters: BookAppointmentArgs,
    execute: async (args, rc) => JSON.stringify(await handlers.book_appointment(args, ctxOf(rc))),
  }),
};
export type ToolName = keyof typeof TOOLS;

export function enabledTools(tenant: TenantConfig): ToolName[] {
  return tenant.receptionist.session.tools.filter((n): n is ToolName => n in TOOLS);
}

// ---- Prompt (prompt.ts) -----------------------------------------------------

export { buildInstructions, greeting, spokenPhone } from './prompt.js';

// ---- Agent + session config -------------------------------------------------

export function buildAgent(tenant: TenantConfig, extras: CallExtras = {}): RealtimeAgent<CallContext> {
  return new RealtimeAgent<CallContext>({
    name: tenant.receptionist.instructions.agentName,
    instructions: buildInstructions(tenant, extras),
    voice: tenant.receptionist.session.audio.output.voice,
    tools: enabledTools(tenant).map((n) => TOOLS[n]),
  });
}

/**
 * Session config the session Lambda sends on attach (accept sends
 * only model + voice + a hold instruction). `tenant.receptionist.session` is the
 * tenant's part, under OpenAI's own keys; the rest are platform defaults (see
 * the levers table in this package's README).
 */
export function sessionOptions(tenant: TenantConfig): Partial<RealtimeSessionOptions<CallContext>> {
  const s = tenant.receptionist.session;
  return {
    model: s.model,
    config: {
      outputModalities: ['audio'],
      audio: {
        input: {
          noiseReduction: { type: 'far_field' },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turnDetection: { type: 'semantic_vad', interruptResponse: true },
        },
        output: { voice: s.audio.output.voice },
      },
    },
  };
}
