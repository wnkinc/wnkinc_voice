import { z } from 'zod';

/** E.164 phone number, e.g. +15555550100 */
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be E.164 (+15555550100)');

/**
 * Per-business receptionist configuration. One item per *called* phone number
 * in the Tenants table; the number is how an inbound call is routed to a tenant.
 */
export const TenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  phoneNumber: E164,
  active: z.boolean().default(true),

  businessName: z.string().min(1),
  description: z.string().optional(),
  services: z.array(z.string()).default([]),
  hours: z.string().optional(),
  timezone: z.string().default('America/Los_Angeles'),

  agentName: z.string().default('Alex'),
  /** Spoken verbatim when the call connects. Defaults to a template if omitted. */
  greeting: z.string().optional(),
  /** Free-form additions appended to the generated system prompt. */
  extraInstructions: z.string().optional(),

  model: z.string().default('gpt-realtime-2.1'),
  voice: z.string().default('marin'),
  /** Tool names (see src/agent.ts) enabled for this tenant. */
  tools: z.array(z.string()).default(['record_lead', 'notify_owner', 'end_call']),

  notifications: z.object({ email: z.email().optional(), sms: E164.optional() }).default({}),

  /** Hard cap; the agent is asked to wrap up and the call is hung up after this. The session Lambda's 15-minute timeout is the ceiling. */
  maxCallSeconds: z.number().int().positive().max(840).default(600),

  /** CRM adapter. Credentials live in Secrets Manager at `<CRM_SECRET_PREFIX><tenantId>`. */
  crm: z.object({ type: z.literal('hubspot') }).optional(),

  /**
   * Platform services this tenant has turned on. Every agent checks its own
   * flag before acting and refuses otherwise (fail closed). Adding a service
   * adds a key here; onboarding a tenant sets the keys — nothing else.
   */
  products: z.object({
    emailResponder: z.object({
      enabled: z.boolean().default(false),
      /** Who brokers the owner's Gmail credential: our Identity vault or Composio. */
      via: z.enum(['vault', 'composio']).default('vault'),
    }).prefault({}),
    backOffice: z.object({ enabled: z.boolean().default(false) }).prefault({}),
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

export interface Lead {
  tenantId: string;
  sk: string; // `${createdAt}#${leadId}` for time-ordered queries
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

/** Domain events on the EventBridge bus. This is the seam where Temporal plugs in later. */
export type VoiceEvent =
  | { type: 'lead.recorded'; tenantId: string; tenantPhoneNumber: string; callId: string; lead: Lead }
  | { type: 'owner.notify'; tenantId: string; tenantPhoneNumber: string; callId: string; summary: string; urgency: 'normal' | 'urgent'; callerPhone?: string }
  | { type: 'call.ended'; tenantId: string; tenantPhoneNumber: string; callId: string; callerPhone?: string; status: CallStatus; durationSeconds: number; transcript: TranscriptEntry[] };
