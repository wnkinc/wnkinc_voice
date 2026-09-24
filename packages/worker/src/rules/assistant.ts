/**
 * The assistant's own tools and the loop's constants. The catalog holds only
 * a tool that carries a rule the model cannot be trusted to keep: today the
 * Facebook ledger's draft and cancel, whose whole point is that the model
 * never publishes. Everything else the assistant reaches is Composio's own
 * tool, listed on the row under assistant.composioTools, its description and
 * schema Composio's, run as the tenant by the loop. A tenant's row lists
 * which catalog names its assistant may use; that list is the allow-list the
 * workflow enforces. The names are ASSISTANT_TOOL_NAMES in the contracts;
 * the catalog must define each and nothing else, which the compiler holds.
 * Pure.
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

export interface LedgerTool {
  description: string;
  parameters: Record<string, unknown>;
}

export const ASSISTANT_TOOLS = {
  // These write the Actions ledger (the workflow runs them). There is no
  // publish tool and there must never be one: the person's POST publishes,
  // matched by the workflow before the model runs.
  draft_facebook_post: {
    description: 'Create or change the draft of a post for the business Facebook Page. This never publishes. The system texts the exact draft to the person, and only their reply POST publishes it. Call it again to change the caption or the photos; each call replaces the whole draft.',
    parameters: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'The full text of the post, as it should appear on the Page' },
        photos: { type: 'array', items: { type: 'string' }, description: 'The photos the post carries, by label from the photo list in your instructions (for example ["p2", "p3"]); [] for a post with no photos. The whole list, not a change: name every photo the draft should have. The result names the photos on the draft; tell the person if there are none.' },
      },
      required: ['caption', 'photos'], additionalProperties: false,
    },
  } satisfies LedgerTool,
  cancel_facebook_draft: {
    description: 'Discard the pending Facebook post draft when the person no longer wants it.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  } satisfies LedgerTool,
} as const satisfies Record<AssistantToolName, LedgerTool>;

export type ToolName = keyof typeof ASSISTANT_TOOLS;
export const TOOL_NAMES = Object.keys(ASSISTANT_TOOLS) as ToolName[];

/** The tool definitions the model sees, in the Responses API's function-tool shape, for the tenant's allow-list. */
export function toolDefs(allowed: readonly string[]) {
  return TOOL_NAMES.filter((n) => allowed.includes(n)).map((name) => ({
    type: 'function', name, description: ASSISTANT_TOOLS[name].description, parameters: ASSISTANT_TOOLS[name].parameters, strict: true,
  }));
}

/** A Composio tool's result for the model: its data on success, the error otherwise, as a bounded string. */
export function boundedResult(body: { successful?: boolean; data?: Record<string, any>; error?: unknown }): string {
  const s = JSON.stringify(body.successful === true ? body.data ?? {} : { error: body.error ?? 'tool failed' });
  return s.length > MAX_TOOL_OUTPUT_CHARS ? `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}...[truncated]` : s;
}

/** What the model is told about a toolkit it reaches, beyond what Composio's schemas say: data, one sentence each. */
export const TOOLKIT_HINTS: Record<string, string> = {
  hubspot: 'Phone numbers in the CRM are stored in E.164 form such as +15095551234, so search with that exact format. When you add a note to a contact, end it with "Added by My Assistant".',
};

/** How each channel wants its replies. */
export const CHANNEL = {
  sms: { verb: 'texting', line: 'This is a text message conversation (SMS): be brief and plain, no markdown, no lists. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 1000 characters.' },
  chat: { verb: 'chatting', line: 'This is a chat: be brief and plain, no markdown. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 3000 characters.' },
} as const;

/** The system prompt for a conversation with one of the tenant's people; `extra` is what a channel appends; `now` is the workflow's clock, so dates the model states or uses are in the business's timezone. */
export function systemPrompt(tenant: TenantRow, person: PersonRecord, channel: keyof typeof CHANNEL, extra = '', now?: string): string {
  const b = tenant.business;
  const tz = b.timezone ?? 'America/Los_Angeles';
  return [
    `You are My Assistant for ${b.name}, ${CHANNEL[channel].verb} with ${person.name} (${person.role}) who works there. `,
    b.description ? `About the business: ${b.description} ` : '',
    b.services?.length ? `Services: ${b.services.join(', ')}. ` : '',
    b.hours ? `Hours: ${b.hours}. ` : '',
    (tenant.assistant?.tools?.length ?? 0) + Object.keys(tenant.assistant?.composioTools ?? {}).length > 0
      ? 'Your tools reach the business systems the owner connected. Use them to look things up or record things; say what you did and what you found. Never invent records. '
      : 'You have no tools connected for this business. ',
    ...Object.keys(tenant.assistant?.composioTools ?? {}).map((k) => (TOOLKIT_HINTS[k] ? `${TOOLKIT_HINTS[k]} ` : '')),
    CHANNEL[channel].line,
    now ? ` The time now is ${now}; the business is in the ${tz} timezone, and every date or time you state or use is in it.` : '',
    extra,
  ].join('');
}

/** The system prompt with what memory recalled appended. */
export function instructions(prompt: string, memories: string[]): string {
  return prompt + (memories.length > 0 ? ` Things you remember about this person and this business: ${memories.join(' | ')}` : '');
}
