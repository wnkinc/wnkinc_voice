/** The one Composio client: every call names the tenant as Composio's user, carries the key, and takes its deadline. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPOSIO_API, composioApi } from '../src/composio-api.js';

const calls: { url: string; init: RequestInit }[] = [];
const respond = (body: unknown, ok = true) => vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response; });
const api = composioApi(async () => 'key-1');
afterEach(() => { calls.length = 0; vi.unstubAllGlobals(); });

describe('composio api', () => {
  it('runs a tool as the tenant, with the key and the pinned version', async () => {
    vi.stubGlobal('fetch', respond({ successful: true, data: { id: 'x' } }));
    const r = await api.executeTool('deck', 'GMAIL_SEND_EMAIL', { to: 'a' }, { version: 'v1' });
    expect(r.data).toEqual({ id: 'x' });
    expect(calls[0]?.url).toBe(`${COMPOSIO_API}tools/execute/GMAIL_SEND_EMAIL`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ user_id: 'deck', arguments: { to: 'a' }, version: 'v1' });
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('key-1');
  });
  it('lists only the tenant\'s ACTIVE accounts, narrowed to a toolkit, and the proxy names the account', async () => {
    vi.stubGlobal('fetch', respond({ items: [{ id: 'acc-1', toolkit: { slug: 'hubspot' } }] }));
    expect(await api.accounts('deck', { toolkit: 'hubspot' })).toEqual([{ id: 'acc-1', toolkit: 'hubspot' }]);
    expect(calls[0]?.url).toContain('user_ids=deck');
    expect(calls[0]?.url).toContain('statuses=ACTIVE');
    expect(calls[0]?.url).toContain('toolkit_slugs=hubspot');
    vi.stubGlobal('fetch', respond({ data: { results: [] } }));
    const signal = AbortSignal.timeout(1000);
    await api.proxy('deck', 'acc-1', 'POST', '/crm/v3/objects/contacts/search', { limit: 1 }, signal);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ endpoint: '/crm/v3/objects/contacts/search', method: 'POST', connected_account_id: 'acc-1', body: { limit: 1 } });
    expect(calls[1]!.init.signal).toBe(signal);
  });
  it('reads each listed tool\'s definition, pinning the newest dated release and never the sentinel; a slug Composio lacks fails', async () => {
    vi.stubGlobal('fetch', respond({ items: [
      { slug: 'B', description: 'b', input_parameters: { type: 'object', properties: { x: { type: 'string' } } }, available_versions: ['00000000_00', '20260101_00', '20260915_00'] },
      { slug: 'A', description: 'a', input_parameters: { type: 'object', properties: {} }, available_versions: ['00000000_00'] },
    ] }));
    expect(await api.toolSchemas(['A', 'B'])).toEqual([
      { slug: 'A', description: 'a', parameters: { type: 'object', properties: {} } },
      { slug: 'B', description: 'b', parameters: { type: 'object', properties: { x: { type: 'string' } } }, version: '20260915_00' },
    ]);
    expect(calls[0]?.url).toBe(`${COMPOSIO_API}tools?tool_slugs=A%2CB`);
    vi.stubGlobal('fetch', respond({ items: [] }));
    await expect(api.toolSchemas(['NOPE'])).rejects.toThrow('no tool NOPE');
  });
  it('refuses a call that names no tenant, and reports a failed response with its status', async () => {
    await expect(api.executeTool('', 'X', {})).rejects.toThrow('no tenant');
    vi.stubGlobal('fetch', respond({ error: 'nope' }, false));
    await expect(api.accounts('deck')).rejects.toThrow('Composio connected_accounts: 500');
  });
});
