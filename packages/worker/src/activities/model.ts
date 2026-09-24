/** One call to OpenAI's Responses API. Rounds inside a turn chain with previous_response_id, so a later round sends only the tool results. */
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

export async function callModel(req: ModelRequest): Promise<ModelResult> {
  const key = (await secret(env('OPENAI_SECRET_ARN'))).OPENAI_API_KEY;
  if (!key || key === 'REPLACE_ME') throw ApplicationFailure.nonRetryable('the OpenAI secret is not filled in');
  const res = await fetch(`${OPENAI_API}responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env('ASSISTANT_MODEL'), store: true, max_output_tokens: MAX_OUTPUT_TOKENS,
      instructions: req.instructions, tools: req.tools, input: req.input,
      ...(req.previousResponseId ? { previous_response_id: req.previousResponseId } : {}),
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    // 429 and 5xx are worth another attempt (the activity's retry policy); the rest are ours to fix.
    if (res.status === 429 || res.status >= 500) throw new Error(`OpenAI ${res.status}: ${text}`);
    throw ApplicationFailure.nonRetryable(`OpenAI ${res.status}: ${text}`);
  }
  const body = await res.json() as { id: string; output?: { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }[]; usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } };
  const output = body.output ?? [];
  return {
    responseId: body.id,
    calls: output.filter((o) => o.type === 'function_call').map((o) => ({ call_id: o.call_id!, name: o.name!, arguments: o.arguments ?? '{}' })),
    reply: output.filter((o) => o.type === 'message').flatMap((o) => (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '')).join(' '),
    tokens: body.usage?.total_tokens ?? 0, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0,
  };
}
