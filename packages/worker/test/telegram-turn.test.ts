/** The Telegram turn: who reaches the assistant, the owner's /login handoff, and the reply through the Bot API. */
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telegramTurn } from '../src/workflows/index.js';
import { answer, fakes, person, run as runWorkflow, tenant, type Fakes, testEnv } from './fakes.js';

const update = (text: string, extra: Record<string, unknown> = {}) => ({ update_id: Math.floor(Math.random() * 1e9), message: { text, from: { id: 777 }, chat: { id: 777, type: 'private' }, ...extra } });
let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await testEnv(); }, 120_000);
afterAll(async () => { await env?.teardown(); });
const run = (f: Fakes, u: ReturnType<typeof update>) => runWorkflow(env, f, telegramTurn, [u]);

describe('telegram turn', () => {
  it('answers a listed person through the Bot API, writes memory, meters tokens', async () => {
    const f = fakes();
    expect(await run(f, update('who is Sarah?'))).toBe('replied');
    expect(f.lookupPerson).toHaveBeenCalledWith('telegram:777');
    expect(f.sendTelegram).toHaveBeenCalledWith(777, 'Sure.');
    expect(f.saveTurn).toHaveBeenCalledWith('deck_telegram_777', expect.stringMatching(/^telegram-chat-777-\d{8}$/), 'who is Sarah?', 'Sure.');
    expect(f.recordUsage).toHaveBeenCalledWith('deck', 'telegram:777', 3, 2, 1);
    expect((f.callModel.mock.calls[0]?.[0].tools as { name: string }[]).map((t) => t.name)).toEqual(['draft_facebook_post', 'cancel_facebook_draft', 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'HUBSPOT_CREATE_NOTE']);
    expect(f.callModel.mock.calls[0]?.[0].instructions).toContain('This is a chat');
  }, 60_000);

  it('a ledger tool asked for on Telegram is refused: no approver on this channel', async () => {
    const f = fakes();
    f.callModel.mockResolvedValueOnce({ responseId: 'r', calls: [{ call_id: 'c', name: 'draft_facebook_post', arguments: '{"caption":"x","photos":"none"}' }], reply: '', tokens: 1, inputTokens: 1, outputTokens: 0 }).mockResolvedValueOnce({ responseId: 'r2', calls: [], reply: 'Ok.', tokens: 1, inputTokens: 1, outputTokens: 0 });
    await run(f, update('post it'));
    expect(f.createDraft).not.toHaveBeenCalled();
    const outputs = f.callModel.mock.calls[1]?.[0].input as { output: string }[];
    expect(outputs[0]?.output).toBe('This tool is not available for this business.');
  }, 60_000);

  it('the owner\'s /login with the browser on starts the login handoff, not the assistant', async () => {
    const f = fakes();
    expect(await run(f, update('/login hubspot'))).toBe('login-started');
    expect(f.callModel).not.toHaveBeenCalled();
  }, 60_000);

  it('/login from an employee, or with the browser off, is a message to the assistant', async () => {
    const f = fakes();
    f.lookupPerson.mockResolvedValue({ ...person, role: 'employee' });
    expect(await run(f, update('/login hubspot'))).toBe('replied');
    const g = fakes();
    g.lookupTenant.mockResolvedValue({ ...tenant, browser: { enabled: false } });
    expect(await run(g, update('/login hubspot'))).toBe('replied');
    expect(g.claimLoginWindow).not.toHaveBeenCalled();
  }, 60_000);

  it('ignores groups, non-text, and strangers', async () => {
    expect(await run(fakes(), update('hi', { chat: { id: 1, type: 'group' } }))).toBe('ignored');
    expect(await run(fakes(), { update_id: 1, message: { from: { id: 777 }, chat: { id: 777, type: 'private' } } } as never)).toBe('ignored');
    const f = fakes();
    f.lookupPerson.mockResolvedValue(undefined);
    expect(await run(f, update('hi'))).toBe('unknown-sender');
    expect(f.sendTelegram).not.toHaveBeenCalled();
  }, 60_000);
});

describe('Composio tools on the row', () => {
  it('shows the model Composio\'s own definitions beside the catalog\'s, runs a call as the tenant with the newest release pinned, and tells the model the time', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...tenant, business: { name: 'Deck Co', timezone: 'America/Chicago' }, assistant: { enabled: true, tools: [], composioTools: { googlecalendar: ['GOOGLECALENDAR_FIND_EVENT'] } } });
    f.callModel.mockResolvedValueOnce(answer('', [{ call_id: 'c1', name: 'GOOGLECALENDAR_FIND_EVENT', arguments: '{"query":"Thursday"}' }])).mockResolvedValueOnce(answer('Thursday is free.'));
    f.executeTool.mockResolvedValueOnce({ successful: true, data: { event_data: { event_data: [] } } });
    expect(await runWorkflow(env, f, telegramTurn, [update('what do I have Thursday')])).toBe('replied');
    expect(f.composioToolDefs).toHaveBeenCalledWith(['GOOGLECALENDAR_FIND_EVENT']);
    const req = f.callModel.mock.calls[0]![0];
    expect((req.tools as { name: string }[]).map((t) => t.name)).toEqual(['GOOGLECALENDAR_FIND_EVENT']);
    expect((req.tools as { description?: string }[])[0]!.description).toBe('GOOGLECALENDAR_FIND_EVENT does a thing');
    expect(req.instructions).toMatch(/The time now is \d{4}-\d{2}-\d{2}T.*America\/Chicago/);
    expect(f.executeTool).toHaveBeenCalledWith('deck', 'GOOGLECALENDAR_FIND_EVENT', { query: 'Thursday' }, '20260915_00');
    const outputs = f.callModel.mock.calls[1]![0].input as { output: string }[];
    expect(JSON.parse(outputs[0]!.output)).toEqual({ event_data: { event_data: [] } });
  });
  it('refuses a Composio tool the row does not list, and fetches no definitions when it lists none', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...tenant, assistant: { enabled: true, tools: [] } });
    f.callModel.mockResolvedValueOnce(answer('', [{ call_id: 'c1', name: 'GOOGLECALENDAR_DELETE_EVENT', arguments: '{"event_id":"x"}' }])).mockResolvedValueOnce(answer('I cannot do that.'));
    await runWorkflow(env, f, telegramTurn, [update('delete my 2pm')]);
    expect(f.composioToolDefs).not.toHaveBeenCalled();
    expect(f.executeTool).not.toHaveBeenCalled();
    const outputs = f.callModel.mock.calls[1]![0].input as { output: string }[];
    expect(outputs[0]!.output).toContain('not available');
  });
});
