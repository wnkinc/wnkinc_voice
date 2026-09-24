/**
 * The assistant's agent loop, shared by every channel: history and recall
 * from memory, then call the model; if it asked for a tool, run it and call
 * again with the result; until it answers or the round cap hits.
 *
 * The model makes every judgment: which tool, what arguments, when to stop.
 * The steps between its decisions are the seam the platform controls: the
 * tool must be on the tenant's allow-list, every Composio call names the
 * tenant, tool results are bounded, rounds are capped, and each call is an
 * activity in the workflow history. A prompt injection that fools the model
 * still meets these.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import type { ComposioToolSchema } from '@wnk/shared/composio-api';
import type { PhotoRow } from '@wnk/shared/contracts';
import { ASSISTANT_TOOLS, FALLBACK_REPLY, MAX_ROUNDS, boundedResult, instructions, toolDefs } from '../../rules/assistant.js';
import { MAX_CAPTION_CHARS, draftedNote, resolvePhotos } from '../../rules/facebook.js';
import { orElse } from '../common.js';

type Activities = typeof activities;
const ledger = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const model = proxyActivities<Activities>({ startToCloseTimeout: '90 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds', backoffCoefficient: 2 } });
const tools = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 2 } });
/** Memory: a failure costs only that; the turn still answers. */
const memory = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 2 } });

export interface LoopInput {
  tenantId: string;
  /** The system prompt before what memory recalled is appended. */
  prompt: string;
  /** The tenant's allow-list, already filtered for the channel. */
  allowed: string[];
  /** The person's text, for memory. */
  text: string;
  /** The user message's content for the model: the text, or text plus images. */
  content: string | unknown[];
  actorId: string;
  sessionId: string;
  /** For the ledger tools: who may approve, and the photos the model was shown (labels resolve against this list, in this order). Absent on channels without them. */
  approver?: string;
  photos?: PhotoRow[];
  /** Composio's definitions of the tools the row lists natively (assistant.composioTools): the model sees them as function tools; each call runs as an activity, as the tenant. */
  composioTools?: readonly ComposioToolSchema[];
}

export interface LoopResult {
  reply: string;
  /** The model never produced text: the reply is the fallback line. */
  gaveUp: boolean;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}

export async function runAssistantLoop(input: LoopInput): Promise<LoopResult> {
  const history = await orElse(memory.loadHistory(input.actorId, input.sessionId), []);
  const memories = await orElse(memory.recall(input.actorId, input.text), []);
  const prompt = instructions(input.prompt, memories);
  const native = input.composioTools ?? [];
  const defs = [...toolDefs(input.allowed), ...native.map((t) => ({ type: 'function', name: t.slug, description: t.description, parameters: t.parameters, strict: false }))];

  let usage = { tokens: 0, inputTokens: 0, outputTokens: 0 };
  const count = (r: { tokens: number; inputTokens: number; outputTokens: number }) => {
    usage = { tokens: usage.tokens + r.tokens, inputTokens: usage.inputTokens + r.inputTokens, outputTokens: usage.outputTokens + r.outputTokens };
  };
  let res = await model.callModel({ instructions: prompt, tools: defs, input: [...history, { role: 'user', content: input.content }] });
  count(res);
  let round = 0;
  while (res.calls.length > 0 && round < MAX_ROUNDS) {
    // Each call the model made, gated and run. A refused or failed tool is a result the model reads, not a failed turn.
    const outputs = await Promise.all(res.calls.map(async (call) => ({
      type: 'function_call_output', call_id: call.call_id, output: await runTool(call.name, call.arguments, input),
    })));
    round += 1;
    res = await model.callModel({ instructions: prompt, tools: defs, previousResponseId: res.responseId, input: outputs });
    count(res);
  }
  const gaveUp = res.calls.length > 0 || res.reply.trim().length === 0;
  return { reply: gaveUp ? FALLBACK_REPLY : res.reply, gaveUp, ...usage };
}

/** One tool call from the model: the allow-list is the gate (the catalog's names on the row, or a Composio tool the row lists); the two ledger tools write drafts and nothing else. */
async function runTool(name: string, rawArgs: string, ctx: LoopInput): Promise<string> {
  const native = (ctx.composioTools ?? []).find((t) => t.slug === name);
  if (!native && (!ctx.allowed.includes(name) || !(name in ASSISTANT_TOOLS))) return 'This tool is not available for this business.';
  const failed = 'The tool failed. Tell the person you could not complete that part.';
  let a: Record<string, unknown>;
  try { a = JSON.parse(rawArgs) as Record<string, unknown>; } catch { return failed; }
  try {
    // Composio's own tool, as the tenant, the newest release pinned; the result as Composio shaped it, bounded.
    if (native) return boundedResult(await tools.executeTool(ctx.tenantId, name, a, native.version));
    if (!ctx.approver) return 'This tool is not available for this business.';
    if (name === 'draft_facebook_post') {
      const caption = typeof a.caption === 'string' ? a.caption : '';
      if (caption.trim().length === 0 || caption.length > MAX_CAPTION_CHARS) return JSON.stringify({ error: `The caption must be 1 to ${MAX_CAPTION_CHARS} characters so the draft fits in one text message.` });
      const photos = resolvePhotos(a.photos, ctx.photos ?? []);
      if ('error' in photos) return JSON.stringify({ error: photos.error });
      // Asked again inside the turn, not read from the earlier lookup: the model may draft twice in one turn.
      const row = await ledger.findPending(ctx.tenantId, ctx.approver);
      if (row) {
        if (!await ledger.reviseDraft(ctx.tenantId, row.sk, row.revision, caption, photos.refs)) return failed;
      } else {
        await ledger.createDraft(ctx.tenantId, ctx.approver, caption, photos.refs);
      }
      return draftedNote(photos.refs);
    }
    if (name === 'cancel_facebook_draft') {
      const row = await ledger.findPending(ctx.tenantId, ctx.approver);
      if (!row) return JSON.stringify({ ok: true, note: 'There was no pending draft.' });
      return await ledger.cancelDraft(ctx.tenantId, row.sk) ? JSON.stringify({ ok: true, note: 'The draft was discarded.' }) : failed;
    }
    return failed;
  } catch {
    return failed;
  }
}

/** One memory session per person per day, rolling at 3 AM tenant-local (sessionDayOffsetMinutes, computed by the seed; 600 = Pacific if unset). */
export function sessionDay(offsetMinutes: number | undefined): string {
  const d = new Date(Date.now() - (offsetMinutes ?? 600) * 60_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
