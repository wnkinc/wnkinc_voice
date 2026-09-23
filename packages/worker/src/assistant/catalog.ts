/**
 * The assistant's tool catalog and the loop's constants: what the model sees
 * (name, description, a slim schema) and what runs when it calls one (a
 * Composio slug, its arguments from the model's `a`, and the shape of the
 * result handed back). A tenant's row lists which names its assistant may
 * use; that list is the allow-list the workflow enforces. The names are
 * ASSISTANT_TOOL_NAMES in the contracts; the catalog must define each and
 * nothing else, which the compiler holds. Pure.
 *
 * Deferred: `send_email`. Sending mail on the model's say-so reaches a
 * customer irreversibly; it gets the ledger's split, a draft tool here and
 * a SEND the workflow matches, never a send tool.
 */
import type { AssistantToolName, PersonRecord, TenantRow } from '@wnk/shared/contracts';

export const MAX_ROUNDS = 6;
export const MAX_TOOL_OUTPUT_CHARS = 6000;
export const MAX_OUTPUT_TOKENS = 1200;
export const FALLBACK_REPLY = 'Sorry, I could not finish that. Try asking in a simpler way.';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export interface ComposioTool {
  description: string;
  parameters: Record<string, unknown>;
  slug: string;
  /** The Composio arguments from the model's arguments; `now` is the workflow's clock. */
  args: (a: Record<string, unknown>, now: string) => Record<string, unknown>;
  /** What the model reads from a successful result's `data`. */
  shape: (data: Record<string, any>) => unknown;
}
export interface LedgerTool {
  description: string;
  parameters: Record<string, unknown>;
}

export const ASSISTANT_TOOLS = {
  search_contacts: {
    description: 'Search the business CRM (HubSpot) for contacts by name, email address, or phone number. Phone numbers are stored in E.164 form such as +15095551234, so search with that exact format.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A name, an email address, or an E.164 phone number' } },
      required: ['query'], additionalProperties: false,
    },
    slug: 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA',
    args: (a) => ({ query: a.query, limit: 5, properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'email', 'company'] }),
    shape: (data) => ({
      total: data.total,
      contacts: ((data.results ?? []) as Record<string, any>[]).map((r) => ({
        id: r.id,
        name: `${text(r.properties?.firstname)} ${text(r.properties?.lastname)}`.trim(),
        phone: r.properties?.phone, mobile: r.properties?.mobilephone, email: r.properties?.email, company: r.properties?.company,
      })),
    }),
  } satisfies ComposioTool,
  add_note: {
    description: 'Add a note to a CRM contact. Use search_contacts first to find the contact id.',
    parameters: {
      type: 'object',
      properties: { contact_id: { type: 'string', description: 'The contact id from search_contacts' }, note: { type: 'string', description: 'The note text' } },
      required: ['contact_id', 'note'], additionalProperties: false,
    },
    slug: 'HUBSPOT_CREATE_NOTE',
    args: (a, now) => ({
      hs_timestamp: now,
      hs_note_body: `${esc(text(a.note))}<br><br>Added by My Assistant`,
      associations: [{ to: { id: a.contact_id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
    }),
    shape: (data) => ({ ok: true, note_id: data.id }),
  } satisfies ComposioTool,
  // No slug: these write the Actions ledger, not Composio (the workflow runs
  // them). There is no publish tool and there must never be one: the person's
  // POST publishes, matched by the workflow before the model runs.
  draft_facebook_post: {
    description: 'Create or change the draft of a post for the business Facebook Page. This never publishes. The system texts the exact draft to the person, and only their reply POST publishes it. Call it again to change the caption or the photos.',
    parameters: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'The full text of the post, as it should appear on the Page' },
        photos: { type: 'string', enum: ['keep', 'use_new', 'add_new', 'none'], description: 'keep: the photos already on the draft. use_new: only the photos the person sent, with this message or a recent one. add_new: the photos on the draft plus the ones they sent. none: a post with no photos. The result says how many photos the draft has; tell the person if it is zero.' },
      },
      required: ['caption', 'photos'], additionalProperties: false,
    },
  } satisfies LedgerTool,
  cancel_facebook_draft: {
    description: 'Discard the pending Facebook post draft when the person no longer wants it.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  } satisfies LedgerTool,
} as const satisfies Record<AssistantToolName, ComposioTool | LedgerTool>;

export type ToolName = keyof typeof ASSISTANT_TOOLS;
export const TOOL_NAMES = Object.keys(ASSISTANT_TOOLS) as ToolName[];
export const isComposioTool = (t: ComposioTool | LedgerTool): t is ComposioTool => 'slug' in t;
export const COMPOSIO_TOOL_NAMES = TOOL_NAMES.filter((n) => isComposioTool(ASSISTANT_TOOLS[n]));

/** The tool definitions the model sees, in the Responses API's function-tool shape, for the tenant's allow-list. */
export function toolDefs(allowed: readonly string[]) {
  return TOOL_NAMES.filter((n) => allowed.includes(n)).map((name) => ({
    type: 'function', name, description: ASSISTANT_TOOLS[name].description, parameters: ASSISTANT_TOOLS[name].parameters, strict: true,
  }));
}

/** A tool result for the model: the shaped data on success, the error otherwise, as a bounded string. */
export function shapeToolResult(body: { successful?: boolean; data?: Record<string, any>; error?: unknown }, shape: ComposioTool['shape']): string {
  const s = JSON.stringify(body.successful === true ? shape(body.data ?? {}) : { error: body.error ?? 'tool failed' });
  return s.length > MAX_TOOL_OUTPUT_CHARS ? `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}...[truncated]` : s;
}

/** How each channel wants its replies. */
export const CHANNEL = {
  sms: { verb: 'texting', line: 'This is a text message conversation (SMS): be brief and plain, no markdown, no lists. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 1000 characters.' },
  chat: { verb: 'chatting', line: 'This is a chat: be brief and plain, no markdown. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 3000 characters.' },
} as const;

/** The system prompt for a conversation with one of the tenant's people; `extra` is what a channel appends. */
export function systemPrompt(tenant: TenantRow, person: PersonRecord, channel: keyof typeof CHANNEL, extra = ''): string {
  const b = tenant.business;
  return [
    `You are My Assistant for ${b.name}, ${CHANNEL[channel].verb} with ${person.name} (${person.role}) who works there. `,
    b.description ? `About the business: ${b.description} ` : '',
    b.services?.length ? `Services: ${b.services.join(', ')}. ` : '',
    b.hours ? `Hours: ${b.hours}. ` : '',
    (tenant.assistant?.tools?.length ?? 0) > 0
      ? 'Your tools reach the business systems the owner connected. Use them to look things up or record things; say what you did and what you found. Never invent records. '
      : 'You have no tools connected for this business. ',
    CHANNEL[channel].line,
    extra,
  ].join('');
}

/** The system prompt with what memory recalled appended. */
export function instructions(prompt: string, memories: string[]): string {
  return prompt + (memories.length > 0 ? ` Things you remember about this person and this business: ${memories.join(' | ')}` : '');
}
