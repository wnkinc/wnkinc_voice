import { z } from 'zod';

/** E.164 phone number, e.g. +15555550100 */
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be E.164 (+15555550100)');

export const PersonSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['owner', 'employee']),
  /** Telegram user id (numeric; the bot sees it on every message). */
  telegramId: z.number().int().positive().optional(),
  /** Mobile number, the identity for SMS (the person texts the tenant's number). */
  phone: E164.optional(),
});
export type Person = z.infer<typeof PersonSchema>;

/** Key of a person's row in the People table: `<channel>:<id>`, e.g. `telegram:12345`. */
export function channelKey(channel: 'telegram' | 'sms', id: string | number): string {
  return `${channel}:${id}`;
}

/** Every channel identity a person carries, as People-table keys. */
export function personChannelKeys(p: Person): string[] {
  const keys: string[] = [];
  if (p.telegramId !== undefined) keys.push(channelKey('telegram', p.telegramId));
  if (p.phone) keys.push(channelKey('sms', p.phone));
  return keys;
}

/** One People-table row: a channel identity that resolves to a tenant and a person. */
export interface PersonRecord {
  channelId: string;
  tenantId: string;
  /** The tenant row's key, so one GetItem reaches the tenant from a person. */
  tenantPhone: string;
  name: string;
  role: Person['role'];
}

/**
 * Per-business receptionist configuration. One item per *called* phone number
 * in the Tenants table; the number is how an inbound call is routed to a tenant.
 */
export const TenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  phoneNumber: E164,
  active: z.boolean().default(true),
  /**
   * Minutes to subtract from UTC so that calendar days roll at 3 AM in the
   * tenant's timezone — the assistant starts a fresh conversation session each
   * day at that cutoff. COMPUTED by the seed from `business.timezone` (Step
   * Functions cannot evaluate IANA zones); reflects DST as of the last seed, so
   * the cutoff drifts an hour across DST changes until the next re-seed. Not in the file.
   */
  sessionDayOffsetMinutes: z.number().int().optional(),

  /** The business facts every service draws on: the receptionist's prompt, the assistant's prompt, the lead email, the CRM notes. */
  business: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    services: z.array(z.string()).default([]),
    hours: z.string().optional(),
    timezone: z.string().default('America/Los_Angeles'),
  }),

  /**
   * Humans allowed to talk to this tenant's assistant, with the channel
   * identities that prove who they are. Telegram vouches for the user id on
   * every message; a phone number is the SMS identity (later). The seed script
   * mirrors each identity into the People table, which is what a channel
   * workflow looks up — an identity not listed here reaches nothing.
   */
  people: z.array(PersonSchema).default([]),

  /**
   * The phone receptionist (OpenAI Realtime over SIP). `session` is passed to
   * OpenAI as the session config under these same keys; `instructions` names
   * what the platform composes into the session's instructions string alongside
   * `business`; the greeting is spoken through a separate response request on
   * connect; the call cap is ours (the session Lambda's deadline), not OpenAI's.
   * Every lever the platform has built appears here with its default; the
   * levers table in packages/voice-session/README.md lists the rest.
   */
  receptionist: z.object({
    session: z.object({
      model: z.string().default('gpt-realtime-2.1'),
      audio: z.object({
        output: z.object({ voice: z.string().default('marin') }).prefault({}),
      }).prefault({}),
      /** Tool names (see voice-session/src/agent.ts) enabled for this tenant. */
      tools: z.array(z.string()).default(['record_lead', 'notify_owner', 'end_call']),
    }).prefault({}),
    instructions: z.object({
      agentName: z.string().default('Alex'),
      /** Free-form additions appended to the generated system prompt. */
      extra: z.string().optional(),
    }).prefault({}),
    /** Spoken verbatim when the call connects. Defaults to a template if omitted. */
    greeting: z.string().optional(),
    /** Hard cap; the agent is asked to wrap up and the call is hung up after this. The session Lambda's 15-minute timeout is the ceiling. */
    maxCallSeconds: z.number().int().positive().max(840).default(600),
  }).prefault({}),

  /**
   * CRM. `via: composio` (the target state) means the owner consented in
   * HubSpot through Composio and the credential lives in Composio's vault under
   * this tenant id. `via: token` is the legacy private-app token in Secrets
   * Manager at `<CRM_SECRET_PREFIX><tenantId>`, removed at the cutover.
   */
  crm: z.object({ type: z.literal('hubspot'), via: z.enum(['token', 'composio']).default('token') }).optional(),

  // ---- Platform services, one block each. Every agent checks its own block's
  // `enabled` before acting and refuses otherwise (fail closed). A service's
  // own data (minted URLs, ids) lives in its block. Adding a service adds a
  // block here; onboarding a tenant sets the blocks — nothing else.

  /** Owner follow-up email per lead, sent from the owner's Gmail through Composio. */
  emailResponder: z.object({ enabled: z.boolean().default(false) }).prefault({}),

  /** Chat assistant for the tenant's own people, over Telegram and SMS. */
  assistant: z.object({
    enabled: z.boolean().default(false),
    /**
     * The assistant's SaaS tools: this tenant's Composio meta-tools MCP session,
     * minted by the seed (`composioAssistant.ensureSession`) and bound to the
     * tenant's connected accounts. The workflow hands it to the harness per
     * invocation; a tenant without one gets no SaaS tools.
     */
    composioMcpUrl: z.url().optional(),
  }).prefault({}),

  /** A saved browser for the business: the owner signs into sites over a live view (`/login` on Telegram); logins persist in Browserbase. */
  browser: z.object({
    enabled: z.boolean().default(false),
    /**
     * The tenant's saved browser: a Browserbase context (cookies and logins,
     * encrypted in their vault) created by the browser-login workflow on the
     * owner's first `/login` and written to the row. Copy it into the file when
     * the workflow says so; a re-seed without it starts a fresh browser.
     */
    contextId: z.string().optional(),
    /** Owned by whoever holds the browser (the browser-login workflow today): ISO time until which a window is open on it, one at a time. Cleared at release; a re-seed clears it too. */
    loginUntil: z.string().optional(),
  }).prefault({}),
});
export type TenantConfig = z.infer<typeof TenantConfigSchema>;
export type TenantConfigInput = z.input<typeof TenantConfigSchema>;

export interface CallParty {
  from?: string;
  to?: string;
}

export type CallStatus = 'claimed' | 'accepted' | 'in_progress' | 'completed' | 'failed';

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result: unknown;
  at: string;
}

export interface CallRecord {
  callId: string;
  tenantId: string;
  tenantPhoneNumber: string;
  from?: string;
  to?: string;
  webhookId?: string;
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  transcript?: TranscriptEntry[];
  toolCalls?: ToolCallRecord[];
  error?: string;
  expiresAt?: number; // DynamoDB TTL (epoch seconds)
}

/**
 * What the receptionist captured, as carried on the `lead.recorded` event. Not
 * a table: the tenant's CRM is the record of the lead, and the call row (the
 * `record_lead` tool call plus the once-markers each consumer writes) is the
 * audit that the platform did what it should. `leadId` keys those markers.
 */
export interface Lead {
  tenantId: string;
  leadId: string;
  callId: string;
  createdAt: string;
  callerName: string;
  phone?: string;
  reason: string;
  preferredCallbackTime?: string;
  notes?: string;
}

/** What the webhook learned about the caller from the CRM before accepting. */
export interface KnownCaller {
  contactId: string;
  name?: string;
  lastNote?: string;
  lastNoteAt?: string;
}

/** Per-call context that shapes the agent beyond the tenant config. */
export interface CallExtras {
  /** Caller ID (E.164), when the carrier provided it. */
  callerPhone?: string;
  knownCaller?: KnownCaller;
  /** Extracted platform memories about this caller (AgentCore Memory). */
  callerMemory?: string[];
}

/** What the webhook puts on the queue for the worker. */
export interface SessionJob {
  callId: string;
  tenantPhoneNumber: string;
  from?: string;
  to?: string;
  startedAt: string;
  extras?: CallExtras;
}

/** Domain events on the EventBridge bus; rules route each to a Step Functions workflow in the runtime stack. */
export type VoiceEvent =
  | { type: 'lead.recorded'; tenantId: string; tenantPhoneNumber: string; callId: string; lead: Lead }
  | { type: 'owner.notify'; tenantId: string; tenantPhoneNumber: string; callId: string; summary: string; urgency: 'normal' | 'urgent'; callerPhone?: string }
  // Ids and outcome only: the transcript stays on the call row, fetched by id by whoever needs it.
  | { type: 'call.ended'; tenantId: string; tenantPhoneNumber: string; callId: string; callerPhone?: string; status: CallStatus; durationSeconds: number };
