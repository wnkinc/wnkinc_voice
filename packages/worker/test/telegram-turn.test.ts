/** The Telegram turn: who reaches the assistant, the owner's /login handoff, and the reply through the Bot API. */
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telegramTurn } from '../src/workflows/index.js';
import { fakes, person, run as runWorkflow, tenant, type Fakes, testEnv } from './fakes.js';

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
    expect((f.callModel.mock.calls[0]?.[0].tools as { name: string }[]).map((t) => t.name)).toEqual(['search_contacts', 'draft_facebook_post', 'cancel_facebook_draft']);
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
