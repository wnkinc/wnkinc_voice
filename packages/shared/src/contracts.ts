/**
 * The contracts: what more than one deployable must agree on, and nothing
 * else. Every export is a constant, an interface, or a type. There is no
 * runtime import, so the Temporal workflow bundle (which takes only pure
 * code) and a CDK stack (which must not reach into the worker's source) can
 * both take this file with nothing behind it; a test holds that. The schemas
 * that validate a tenant file are in types.ts, imported here as types only.
 *
 * Who reads what:
 *   - the receptionist publishes VoiceEvent and writes TranscriptEntry rows;
 *   - the worker reads rows (TenantRow, PersonRecord, DraftRow), takes events
 *     (LeadRecorded, CallEnded, OwnerNotify), and runs the registries;
 *   - a tenant file lists AUTOMATIONS by name (TenantAutomations), and the
 *     tenant stack makes a rule per entry from the event each names.
 */
import type { Action, TenantConfigInput } from './types.js';

// ---- Names every side must spell the same -----------------------------------

/**
 * The assistant's own tools by name: the ones that carry a rule the model
 * cannot be trusted to keep (today, the Facebook ledger's draft and cancel).
 * A tenant row lists which its assistant may use, and the worker's catalog
 * defines each. Everything else the assistant reaches is Composio's own tool,
 * listed on the row under assistant.composioTools.
 */
export const ASSISTANT_TOOL_NAMES = ['draft_facebook_post', 'cancel_facebook_draft'] as const;
export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

/** Each action type and the exact word (any case, nothing else in the message) that approves it. It names the action so a YES meant for something else approves nothing. */
export const ACTION_APPROVAL_WORDS = { facebook_post: 'POST' } as const;
export type ActionType = keyof typeof ACTION_APPROVAL_WORDS;
export const ACTION_STATUSES = ['pending', 'executing', 'completed', 'failed', 'rejected'] as const;

export type CallStatus = 'claimed' | 'accepted' | 'in_progress' | 'completed' | 'failed';

// ---- Rows, as they are read back ---------------------------------------------

/**
 * A Tenants-table row as the worker reads it: the tenant file's shape before
 * the schema's defaults, since a row seeded under an earlier schema may lack a
 * field a later one defaults. Reading code checks a flag with `=== true`.
 */
export type TenantRow = TenantConfigInput;

/** One People-table row: a channel identity that resolves to a tenant and a person. */
export interface PersonRecord {
  channelId: string;
  tenantId: string;
  /** The tenant row's key, so one GetItem reaches the tenant from a person. */
  tenantPhone: string;
  name: string;
  role: 'owner' | 'employee';
}

/** A transcript line on a call row. */
export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
}

/** A texted photo by its Twilio ids; links are minted when needed, never stored. */
export interface Photo {
  messageSid: string;
  mediaSid: string;
}

/** An Actions-table row for a Facebook post draft: the fields the workflow reads. */
export type DraftRow = Pick<Action, 'tenantId' | 'sk' | 'status' | 'revision' | 'shownRevision' | 'approveBy' | 'payload'>;

// ---- Events on the bus --------------------------------------------------------

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

/** Domain events on the EventBridge bus; rules route each to a workflow on the worker (the platform's, or a tenant's). */
export type VoiceEvent =
  | { type: 'lead.recorded'; tenantId: string; tenantPhoneNumber: string; callId: string; lead: Lead }
  | { type: 'owner.notify'; tenantId: string; tenantPhoneNumber: string; callId: string; summary: string; urgency: 'normal' | 'urgent'; callerPhone?: string }
  // Ids and outcome only: the transcript stays on the call row, fetched by id by whoever needs it.
  | { type: 'call.ended'; tenantId: string; tenantPhoneNumber: string; callId: string; callerPhone?: string; status: CallStatus; durationSeconds: number };
export type VoiceEventType = VoiceEvent['type'];

/** An event as a rule hands it to a workflow: the detail, without the type that routed it. */
export type EventDetail<T extends VoiceEventType> = Omit<Extract<VoiceEvent, { type: T }>, 'type'>;
export type LeadRecorded = EventDetail<'lead.recorded'>;
export type OwnerNotify = EventDetail<'owner.notify'>;
export type CallEnded = EventDetail<'call.ended'>;

// ---- The registries: what runs on the bus, by workflow name -------------------

/**
 * The automations a tenant may run, keyed by the workflow that runs it, each
 * with the event that starts it. A tenant's file lists the ones it gets; the
 * tenant stack makes a rule per entry that matches that tenant's events alone
 * and starts the named workflow with the event and the tenant's options. A
 * variation is an option there, never a conditional a shared workflow
 * branches on for one tenant.
 */
export const AUTOMATIONS = {
  /** lead.recorded -> the owner's email from their own Gmail, with what the CRM and memory already know. */
  leadEmail: { on: 'lead.recorded' },
  /** lead.recorded -> the contact upserted, a note, a follow-up task the next business morning. */
  crmLead: { on: 'lead.recorded' },
  /** call.ended -> a transcript note on the caller's contact, when they are already one. */
  crmCall: { on: 'call.ended' },
  /** owner.notify -> the owner's Telegram. */
  ownerAlert: { on: 'owner.notify' },
} as const satisfies Record<string, { on: VoiceEventType }>;
export type AutomationName = keyof typeof AUTOMATIONS;

/**
 * The platform's own: what every tenant gets identically and no tenant
 * varies. Its rule lives in the worker stack; a tenant file cannot name it.
 */
export const PLATFORM_AUTOMATIONS = {
  /** call.ended -> the transcript into the caller's memory, the minutes metered. */
  callEnded: { on: 'call.ended' },
} as const satisfies Record<string, { on: VoiceEventType }>;
export type PlatformAutomationName = keyof typeof PLATFORM_AUTOMATIONS;

/** A workflow name a rule may hand the automation starter. */
export const isAutomation = (name: string): name is AutomationName | PlatformAutomationName => name in AUTOMATIONS || name in PLATFORM_AUTOMATIONS;

/** One entry of a tenant's automations: the workflow and this tenant's options for it. */
export interface TenantAutomation {
  readonly workflow: AutomationName;
  readonly options?: Readonly<Record<string, unknown>>;
}

/** What a tenant file exports: the id and the automations that tenant gets. */
export interface TenantAutomations {
  readonly tenantId: string;
  readonly automations: readonly TenantAutomation[];
  /** Serve this tenant's Telegram account as an MCP server, in its own stack. */
  readonly telegramMcp?: boolean;
}
