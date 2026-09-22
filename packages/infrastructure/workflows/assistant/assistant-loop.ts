/**
 * The assistant's agent loop, as states: call the model; if it asked for a
 * tool, run it and call again with the result; until it answers or the round
 * cap hits. Shared by the Telegram and SMS workflows and the assistant
 * canary, which spread these states in place of a runtime.
 *
 * The model makes every judgment: which tool, what arguments, when to stop.
 * The states between its decisions are mechanical and are the seam the
 * platform controls: the tool must be on the tenant's allow-list, every
 * Composio call names the tenant, tool results are bounded, rounds are
 * capped, and each call is a line in the execution history. A prompt
 * injection that fools the model still meets these.
 *
 * Rounds inside one turn chain with OpenAI's previous_response_id, so a
 * later round sends only the tool results, not the conversation: state
 * stays far under Step Functions' 256 KB. History across turns comes from
 * AgentCore Memory at the start of each turn and the turn is written back
 * at the end; the Memory service extracts facts and preferences on its own.
 *
 * What the workflow assigns before entering (see the callers):
 *   $text, $systemPrompt, $actorId, $sessionId, $allowedTools, $tenant,
 *   plus `assistantPrepare()` (tool definitions, counters).
 * What it leaves: $reply (the text to send) and $tokens, $inputTokens,
 * $outputTokens (for usage; output costs several times input, so the usage
 * row carries the split).
 */
import { COMPOSIO_API, OPENAI_API, composio, q } from '../asl.js';

export interface AssistantLoopRefs {
  openaiConnectionArn: string;
  composioConnectionArn: string;
  /** Platform memory; omit and the history and recall states are not emitted. */
  memoryId?: string;
  /** OpenAI model id for the Responses API. */
  model: string;
}

export const MAX_ROUNDS = 6;
export const MAX_TOOL_OUTPUT_CHARS = 6000;
export const MAX_OUTPUT_TOKENS = 1200;
export const FALLBACK_REPLY = 'Sorry, I could not finish that. Try asking in a simpler way.';

/** HTML-escape a JSONata string expression (HubSpot note bodies are HTML). */
const esc = (expr: string) => `$replace($replace($replace(${expr}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;

/**
 * The tool catalog: what the model sees (name, description, a slim schema)
 * and what runs when it calls one (a Composio slug, its arguments from the
 * model's `$a`, and the shape of the result handed back). A tenant's row
 * lists which names its assistant may use; that list is the allow-list the
 * Gate state enforces. Mirror of ASSISTANT_TOOL_NAMES in @wnk/shared.
 *
 * Deferred: `send_email`. Sending mail on the model's say-so reaches a
 * customer irreversibly. The Actions ledger exists now (facebook-post.ts is
 * its first user): email gets the same split, a draft tool here and a SEND
 * the workflow matches, never a send tool.
 */
export const ASSISTANT_TOOLS = {
  search_contacts: {
    description: 'Search the business CRM (HubSpot) for contacts by name, email address, or phone number. Phone numbers are stored in E.164 form such as +15095551234, so search with that exact format.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A name, an email address, or an E.164 phone number' } },
      required: ['query'], additionalProperties: false,
    },
    slug: 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA',
    args: { query: q('$a.query'), limit: 5, properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'email', 'company'] },
    shape: "{ 'total': data.total, 'contacts': [data.results.{ 'id': id, 'name': $trim(($exists(properties.firstname) and properties.firstname != null ? properties.firstname : '') & ' ' & ($exists(properties.lastname) and properties.lastname != null ? properties.lastname : '')), 'phone': properties.phone, 'mobile': properties.mobilephone, 'email': properties.email, 'company': properties.company }] }",
  },
  add_note: {
    description: 'Add a note to a CRM contact. Use search_contacts first to find the contact id.',
    parameters: {
      type: 'object',
      properties: { contact_id: { type: 'string', description: 'The contact id from search_contacts' }, note: { type: 'string', description: 'The note text' } },
      required: ['contact_id', 'note'], additionalProperties: false,
    },
    slug: 'HUBSPOT_CREATE_NOTE',
    args: {
      hs_timestamp: q('$now()'),
      hs_note_body: q(`${esc('$a.note')} & '<br><br>Added by My Assistant'`),
      associations: [{ to: { id: q('$a.contact_id') }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
    },
    shape: "{ 'ok': successful = true, 'note_id': data.id }",
  },
  // No slug: these run states their channel supplies (workflows/assistant/facebook-post.ts),
  // because they write the Actions ledger, not Composio. There is no publish
  // tool and there must never be one: the person's POST publishes, matched by
  // the workflow before the model runs.
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
  },
  cancel_facebook_draft: {
    description: 'Discard the pending Facebook post draft when the person no longer wants it.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
} as const;

export type AssistantToolName = keyof typeof ASSISTANT_TOOLS;
type ComposioTool = { slug: string; args: Record<string, unknown>; shape: string };
const isComposioTool = (t: object): t is ComposioTool => 'slug' in t;
/** The tools every channel's loop carries: the ones that are a single Composio call. */
export const COMPOSIO_TOOL_NAMES = (Object.keys(ASSISTANT_TOOLS) as AssistantToolName[]).filter((n) => isComposioTool(ASSISTANT_TOOLS[n]));

export interface AssistantLoopOptions {
  /** The catalog entries this channel's loop carries. Default: the Composio ones. */
  tools?: readonly AssistantToolName[];
  /** States for the carried tools that have no slug, inside the tool Map: each enters at `Run_<name>` and ends with Output { call_id, output }. */
  runners?: Record<string, unknown>;
  /** The user message's `content` for the model, a JSONata fragment. Default: the text. */
  content?: string;
}

/** The tool definitions the model sees, in the Responses API's function-tool shape. Filtered per tenant at call time. */
export function assistantToolDefs(tools: readonly AssistantToolName[] = COMPOSIO_TOOL_NAMES) {
  return tools.map((name) => ({ type: 'function', name, description: ASSISTANT_TOOLS[name].description, parameters: ASSISTANT_TOOLS[name].parameters, strict: true }));
}

/** Constant variables the loop needs; a caller merges these into its Prepare state's Assign. */
export function assistantPrepare(tools?: readonly AssistantToolName[]) {
  return { toolDefs: assistantToolDefs(tools), round: 0, tokens: 0, inputTokens: 0, outputTokens: 0, history: [] as unknown[], memories: [] as unknown[] };
}

// ---- Expressions (exported unwrapped so the tests can evaluate them) ---------

/** The model's tool calls from a Responses API body. */
export const callsExpr = (bodyExpr: string) => `[${bodyExpr}.output[type='function_call']]`;
/** The model's text from a Responses API body, '' when it only called tools. */
export const textExpr = (bodyExpr: string) =>
  `$count(${bodyExpr}.output[type='message']) > 0 ? $join(${bodyExpr}.output[type='message'].content[type='output_text'].text, ' ') : ''`;
/** Tool results as the next round's input items. Outer brackets: JSONata unwraps a one-item array. */
export const outputsExpr = (resultsExpr: string) => `[[${resultsExpr}].{ 'type': 'function_call_output', 'call_id': call_id, 'output': output }]`;
/** A tool result for the model: the shaped body on success, the error otherwise, as a bounded string. */
export const toolResultExpr = (bodyExpr: string, shape: string) =>
  `( $r := ${bodyExpr}; $s := $string($r.successful = true ? $r.${shape} : { 'error': ($exists($r.error) and $r.error != null ? $r.error : 'tool failed') }); { 'call_id': $callId, 'output': ($length($s) > ${MAX_TOOL_OUTPUT_CHARS} ? $substring($s, 0, ${MAX_TOOL_OUTPUT_CHARS}) & '...[truncated]' : $s) } )`;
/** Session history as Responses API input messages, oldest first. */
export const historyExpr = (eventsExpr: string) =>
  `[$sort([${eventsExpr}], function($l, $r) { $l.EventTimestamp > $r.EventTimestamp }).Payload.Conversational.{ 'role': $lowercase(Role), 'content': Content.Text }]`;
/** The system prompt with what memory recalled appended. */
export const instructionsExpr = "$systemPrompt & ($count($memories) > 0 ? ' Things you remember about this person and this business: ' & $join($memories, ' | ') : '')";

// ---- States -----------------------------------------------------------------

/** The state the loop starts at. */
export const assistantLoopStart = (refs: AssistantLoopRefs) => (refs.memoryId ? 'LoadHistory' : 'CallModel');

/** The loop's states; `exit` is the caller's state after the loop (its Reply). */
export function assistantLoopStates(refs: AssistantLoopRefs, exit: string, opts: AssistantLoopOptions = {}) {
  const tools = opts.tools ?? COMPOSIO_TOOL_NAMES;
  const crm = composio(refs.composioConnectionArn, q('$tenant.tenantId.S'));
  const modelCall = (body: Record<string, unknown>) => ({
    Type: 'Task', Resource: 'arn:aws:states:::http:invoke',
    Arguments: {
      ApiEndpoint: `${OPENAI_API}responses`, Method: 'POST',
      Authentication: { ConnectionArn: refs.openaiConnectionArn },
      Headers: { 'content-type': 'application/json' },
      RequestBody: { model: refs.model, store: true, max_output_tokens: MAX_OUTPUT_TOKENS, instructions: q(instructionsExpr), tools: q('[$toolDefs[name in $allowedTools]]'), ...body },
    },
    Retry: [{ ErrorEquals: ['States.Http.StatusCode.429', 'States.Http.StatusCode.500', 'States.Http.StatusCode.502', 'States.Http.StatusCode.503', 'States.Http.StatusCode.504'], IntervalSeconds: 2, MaxAttempts: 2, BackoffRate: 2 }],
    Assign: {
      responseId: q('$states.result.ResponseBody.id'),
      calls: q(callsExpr('$states.result.ResponseBody')),
      reply: q(textExpr('$states.result.ResponseBody')),
      tokens: q('$tokens + $states.result.ResponseBody.usage.total_tokens'),
      inputTokens: q('$inputTokens + $states.result.ResponseBody.usage.input_tokens'),
      outputTokens: q('$outputTokens + $states.result.ResponseBody.usage.output_tokens'),
    },
    Output: q('$states.input'), Next: 'Decide',
  });

  // One Choice branch and one execute state per catalog entry: the Gate is the allow-list.
  const gate = tools.map((name) => ({ Condition: q(`$tool = '${name}' and '${name}' in $allowedTools`), Next: `Run_${name}` }));
  const runners = {
    ...Object.fromEntries(tools.map((name) => [name, ASSISTANT_TOOLS[name]] as const).filter(([, t]) => isComposioTool(t)).map(([name, t]) => [`Run_${name}`, {
      ...crm.execute((t as ComposioTool).slug, (t as ComposioTool).args),
      Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Failed' }],
      Output: q(toolResultExpr('$states.result.ResponseBody', (t as ComposioTool).shape)),
      End: true,
    }])),
    ...(opts.runners ?? {}),
  };

  return {
    ...(refs.memoryId ? {
      // This session's earlier turns, oldest first. Nothing on failure: the
      // turn still answers, without context.
      LoadHistory: {
        Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:listEvents',
        Arguments: { MemoryId: refs.memoryId, ActorId: q('$actorId'), SessionId: q('$sessionId'), IncludePayloads: true, MaxResults: 20 },
        Assign: { history: q(historyExpr('$states.result.Events')) },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'Recall' }],
        Output: q('$states.input'), Next: 'Recall',
      },
      // What the Memory service extracted about this person across all their
      // sessions: facts, preferences, summaries. Relevance-ranked by the text.
      Recall: {
        Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:retrieveMemoryRecords',
        TimeoutSeconds: 5,
        Arguments: { MemoryId: refs.memoryId, NamespacePath: q("'/callers/' & $actorId"), SearchCriteria: { SearchQuery: q('$text'), TopK: 8 } },
        Assign: { memories: q('[$states.result.MemoryRecordSummaries.Content.Text]') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'CallModel' }],
        Output: q('$states.input'), Next: 'CallModel',
      },
    } : {}),
    CallModel: modelCall({ input: q(`$append($history, [{ 'role': 'user', 'content': ${opts.content ?? '$text'} }])`) }),
    Decide: {
      Type: 'Choice',
      Choices: [
        { Condition: q(`$count($calls) > 0 and $round < ${MAX_ROUNDS}`), Next: 'RunTools' },
        { Condition: q('$count($calls) > 0'), Next: 'GiveUp' },
        { Condition: q('$length($trim($reply)) = 0'), Next: 'GiveUp' },
      ],
      Default: exit,
    },
    // Each call the model made, gated and run. A refused or failed tool is
    // a result the model reads, not a failed turn.
    RunTools: {
      Type: 'Map',
      Items: q('$calls'),
      MaxConcurrency: 3,
      ItemProcessor: {
        ProcessorConfig: { Mode: 'INLINE' },
        StartAt: 'Args',
        States: {
          Args: {
            Type: 'Pass',
            Assign: { callId: q('$states.input.call_id'), tool: q('$states.input.name'), a: q('$parse($states.input.arguments)') },
            Output: q('$states.input'), Next: 'Gate',
          },
          Gate: { Type: 'Choice', Choices: gate, Default: 'Denied' },
          Denied: { Type: 'Pass', Output: q("{ 'call_id': $callId, 'output': 'This tool is not available for this business.' }"), End: true },
          ...runners,
          Failed: { Type: 'Pass', Output: q("{ 'call_id': $callId, 'output': 'The tool failed. Tell the person you could not complete that part.' }"), End: true },
        },
      },
      Assign: { outputs: q(outputsExpr('$states.result')), round: q('$round + 1') },
      Output: q('$states.input'), Next: 'Continue',
    },
    Continue: modelCall({ previous_response_id: q('$responseId'), input: q('$outputs') }),
    GiveUp: { Type: 'Pass', Assign: { reply: FALLBACK_REPLY }, Output: q('$states.input'), Next: exit },
  };
}

/** Writes the turn to the person's session in Memory; the caller adds Next. Omitted when the platform has no memory. */
export function assistantSaveTurnState(refs: AssistantLoopRefs) {
  if (!refs.memoryId) return undefined;
  return {
    Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:createEvent',
    Arguments: {
      MemoryId: refs.memoryId,
      ActorId: q('$actorId'), SessionId: q('$sessionId'), EventTimestamp: q('$now()'),
      Payload: [
        { Conversational: { Role: 'USER', Content: { Text: q('$text') } } },
        { Conversational: { Role: 'ASSISTANT', Content: { Text: q('$reply') } } },
      ],
    },
  };
}

/** What the loop's state machine role must reach: both Connections' APIs. */
export const ASSISTANT_LOOP_ENDPOINTS = [`${OPENAI_API}*`, `${COMPOSIO_API}*`];
