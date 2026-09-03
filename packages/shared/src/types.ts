import { z } from 'zod';

/** E.164 phone number, e.g. +15555550100 */
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be E.164 (+15555550100)');

export const PersonSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['owner', 'employee']),
  /** Telegram user id (numeric; the bot sees it on every message). */
  telegramId: z.number().int().positive().optional(),
  /** Mobile number, the identity for SMS once that channel exists. */
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
   * The tenant's own Cognito app client (client-credentials). Every agent acting
   * for this tenant calls the Gateway as THIS client; the Gateway's request
   * interceptor maps the validated client_id back to the tenant and injects
   * tenant context into every tool call. Created by the seed script when
   * missing; the secret stays in Cognito (agents fetch it through IAM).
   */
  cognitoClientId: z.string().min(1).optional(),
  /**
   * AgentCore Identity OAuth2 credential provider wrapping that client
   * (client-credentials against Cognito). The assistant harness is handed
   * this per invocation so it reaches the Gateway AS the tenant. Minted by
   * the seed next to the client.
   */
  gatewayOauthProviderArn: z.string().min(1).optional(),

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

  /**
   * CRM. `via: composio` (the target state) means the owner consented in
   * HubSpot through Composio and the credential lives in Composio's vault under
   * this tenant id. `via: token` is the legacy private-app token in Secrets
   * Manager at `<CRM_SECRET_PREFIX><tenantId>`, removed at the cutover.
   */
  crm: z.object({ type: z.literal('hubspot'), via: z.enum(['token', 'composio']).default('token') }).optional(),

  /**
   * Humans allowed to talk to this tenant's assistant, with the channel
   * identities that prove who they are. Telegram vouches for the user id on
   * every message; a phone number is the SMS identity (later). The seed script
   * mirrors each identity into the People table, which is what a channel
   * workflow looks up — an identity not listed here reaches nothing.
   */
  people: z.array(PersonSchema).default([]),

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
    /** Chat assistant for the tenant's own people (Telegram now, SMS later). */
    assistant: z.object({ enabled: z.boolean().default(false) }).prefault({}),
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
