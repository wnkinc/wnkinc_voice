/** Calls to OpenAI's Responses API: the assistant's turn (rounds chain with previous_response_id, so a later round sends only the tool results), and the one-line descriptions of texted photos. */
import { ApplicationFailure } from '@temporalio/activity';
import { MAX_OUTPUT_TOKENS } from '../rules/assistant.js';
import { env, secret } from './config.js';

export const OPENAI_API = 'https://api.openai.com/v1/';

export interface ModelCall { call_id: string; name: string; arguments: string }
export interface ModelResult { responseId: string; calls: ModelCall[]; reply: string; tokens: number; inputTokens: number; outputTokens: number }
export interface ModelRequest {
  instructions: string;
  tools: unknown[];
  input: unknown[];
  previousResponseId?: string;
}

type ResponsesBody = { id: string; output?: { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }[]; usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } };

async function responses(body: Record<string, unknown>): Promise<ResponsesBody> {
  const key = (await secret(env('OPENAI_SECRET_ARN'))).OPENAI_API_KEY;
  if (!key || key === 'REPLACE_ME') throw ApplicationFailure.nonRetryable('the OpenAI secret is not filled in');
  const res = await fetch(`${OPENAI_API}responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: env('ASSISTANT_MODEL'), ...body }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    // 429 and 5xx are worth another attempt (the activity's retry policy); the rest are ours to fix.
    if (res.status === 429 || res.status >= 500) throw new Error(`OpenAI ${res.status}: ${text}`);
    throw ApplicationFailure.nonRetryable(`OpenAI ${res.status}: ${text}`);
  }
  return res.json() as Promise<ResponsesBody>;
}

const textOf = (body: ResponsesBody) => (body.output ?? []).filter((o) => o.type === 'message').flatMap((o) => (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '')).join(' ');

export async function callModel(req: ModelRequest): Promise<ModelResult> {
  const body = await responses({
    store: true, max_output_tokens: MAX_OUTPUT_TOKENS,
    instructions: req.instructions, tools: req.tools, input: req.input,
    ...(req.previousResponseId ? { previous_response_id: req.previousResponseId } : {}),
  });
  const output = body.output ?? [];
  return {
    responseId: body.id,
    calls: output.filter((o) => o.type === 'function_call').map((o) => ({ call_id: o.call_id!, name: o.name!, arguments: o.arguments ?? '{}' })),
    reply: textOf(body),
    tokens: body.usage?.total_tokens ?? 0, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0,
  };
}

/**
 * One line per photo, so a person can tell them apart in a draft ("the tile
 * floor; the new sink") and the model can name them in a later text without
 * seeing them again. A fixed step at arrival, not a tool the model may skip.
 */
export async function describeImages(urls: string[]): Promise<{ descriptions: string[]; tokens: number; inputTokens: number; outputTokens: number }> {
  if (urls.length === 0) return { descriptions: [], tokens: 0, inputTokens: 0, outputTokens: 0 };
  const body = await responses({
    store: false, max_output_tokens: 40 * urls.length + 40,
    instructions: `Describe each photo in one short lowercase phrase of at most eight words, naming what it shows (the subject, not the quality). Answer with exactly ${urls.length} lines, one per photo in order, no numbering, no other text.`,
    input: [{ role: 'user', content: urls.map((image_url) => ({ type: 'input_image', image_url })) }],
  });
  const lines = textOf(body).split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean);
  const descriptions = urls.map((_, i) => (lines[i] ?? 'photo').slice(0, 80));
  return { descriptions, tokens: body.usage?.total_tokens ?? 0, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
}
