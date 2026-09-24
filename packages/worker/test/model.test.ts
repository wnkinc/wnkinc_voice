/** The model activity's request: the MCP session rides as a remote MCP tool with the Composio key as bearer, and only when a session was minted. */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wnk/shared/secrets', () => ({ jsonSecret: vi.fn(async (arn: string) => (arn.includes('openai') ? { OPENAI_API_KEY: 'sk-test' } : { COMPOSIO_API_KEY: 'ak-composio' })) }));
process.env.OPENAI_SECRET_ARN = 'arn:openai'; process.env.COMPOSIO_SECRET_ARN = 'arn:composio'; process.env.ASSISTANT_MODEL = 'gpt-test';
const { callModel } = await import('../src/activities/model.js');

const sent: Record<string, unknown>[] = [];
const respond = (output: unknown[]) => vi.fn(async (_url: string, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return { ok: true, status: 200, json: async () => ({ id: 'resp', output, usage: { total_tokens: 3, input_tokens: 2, output_tokens: 1 } }) } as unknown as Response; });
afterEach(() => { sent.length = 0; vi.unstubAllGlobals(); });

describe('callModel', () => {
  it('adds the MCP session as a tool with the Composio key, approval never, beside the function tools', async () => {
    vi.stubGlobal('fetch', respond([{ type: 'mcp_call', server_label: 'composio', name: 'GOOGLECALENDAR_FIND_EVENT', arguments: '{"query":"x"}' }, { type: 'message', content: [{ type: 'output_text', text: 'Free.' }] }]));
    const r = await callModel({ instructions: 'i', tools: [{ type: 'function', name: 'search_contacts' }], input: [], mcpUrl: 'https://mcp.example/s' });
    expect(sent[0]!.tools).toEqual([{ type: 'function', name: 'search_contacts' }, { type: 'mcp', server_label: 'composio', server_url: 'https://mcp.example/s', authorization: 'ak-composio', require_approval: 'never' }]);
    expect(r.mcpCalls).toEqual([{ server: 'composio', name: 'GOOGLECALENDAR_FIND_EVENT', arguments: '{"query":"x"}' }]);
    expect(r.reply).toBe('Free.');
  });
  it('sends only the function tools when no session was minted, and records an MCP call\'s error', async () => {
    vi.stubGlobal('fetch', respond([{ type: 'mcp_call', server_label: 'composio', name: 'X', arguments: '{}', error: { message: 'boom' } }]));
    const r = await callModel({ instructions: 'i', tools: [], input: [] });
    expect(sent[0]!.tools).toEqual([]);
    expect(r.mcpCalls[0]?.error).toBe('boom');
  });
});
