import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createOpenAI } from '@wnk/shared';
import { memoryStore } from '@wnk/shared';
import type { SessionJob } from '@wnk/shared';
import { createWebhookHandler } from '../src/webhook.js';
import { incomingCallBody, makeWebhookSecret, signWebhook, silentLog, TENANT } from './helpers.js';

function setup() {
  const secret = makeWebhookSecret();
  const openai = createOpenAI({ OPENAI_API_KEY: 'sk-test', OPENAI_WEBHOOK_SECRET: secret });
  const accept = vi.spyOn(openai.realtime.calls, 'accept').mockResolvedValue(undefined as never);
  const reject = vi.spyOn(openai.realtime.calls, 'reject').mockResolvedValue(undefined as never);
  const store = memoryStore([TENANT, { ...TENANT, tenantId: 'inactive', phoneNumber: '+15555550109', active: false }]);
  const calls = store.calls;
  const jobs: SessionJob[] = [];
  const handler = createWebhookHandler({
    secrets: async () => ({ OPENAI_API_KEY: 'sk-test', OPENAI_WEBHOOK_SECRET: secret }),
    openai: () => openai,
    store: () => store,
    startSession: async (job) => { jobs.push(job); },
    log: silentLog,
  });
  const post = async (body: string, headers: Record<string, string>, base64 = false) => {
    const event = {
      body: base64 ? Buffer.from(body).toString('base64') : body,
      isBase64Encoded: base64,
      headers: { 'content-type': 'application/json', ...headers },
    } as unknown as APIGatewayProxyEventV2;
    return (await handler(event, {} as never, () => {})) as APIGatewayProxyStructuredResultV2;
  };
  return { secret, accept, reject, calls, jobs, post };
}

describe('webhook handler', () => {
  it('accepts a call for a known number and starts a session', async () => {
    const { secret, accept, jobs, calls, post } = setup();
    const body = incomingCallBody('call_A');
    const res = await post(body, signWebhook(secret, body));
    expect(res.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
    const [callId, params] = accept.mock.calls[0]!;
    expect(callId).toBe('call_A');
    expect(params).toMatchObject({ type: 'realtime', model: 'gpt-realtime-2.1' });
    expect(jobs).toEqual([expect.objectContaining({ callId: 'call_A', tenantPhoneNumber: '+15555550100', from: '+15555550123' })]);
    expect(calls.get('call_A')?.status).toBe('accepted');
  });

  it('handles base64-encoded bodies from API Gateway', async () => {
    const { secret, accept, post } = setup();
    const body = incomingCallBody('call_B');
    const res = await post(body, signWebhook(secret, body), true);
    expect(res.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('rejects bad signatures with 400 and never touches the call', async () => {
    const { accept, post } = setup();
    const body = incomingCallBody('call_C');
    const res = await post(body, signWebhook(makeWebhookSecret(), body));
    expect(res.statusCode).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects stale timestamps', async () => {
    const { secret, post } = setup();
    const body = incomingCallBody('call_C2');
    const res = await post(body, signWebhook(secret, body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }));
    expect(res.statusCode).toBe(400);
  });

  it('is idempotent across webhook retries', async () => {
    const { secret, accept, jobs, post } = setup();
    const body = incomingCallBody('call_D');
    const headers = signWebhook(secret, body);
    expect((await post(body, headers)).statusCode).toBe(200);
    expect((await post(body, headers)).statusCode).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(1);
  });

  it('rejects calls to unknown numbers (404) and inactive tenants (603)', async () => {
    const { secret, accept, reject, post } = setup();
    let body = incomingCallBody('call_E', '+15555559999');
    expect((await post(body, signWebhook(secret, body))).statusCode).toBe(200);
    expect(reject).toHaveBeenLastCalledWith('call_E', { status_code: 404 });
    body = incomingCallBody('call_F', '+15555550109');
    expect((await post(body, signWebhook(secret, body))).statusCode).toBe(200);
    expect(reject).toHaveBeenLastCalledWith('call_F', { status_code: 603 });
    expect(accept).not.toHaveBeenCalled();
  });

  it('returns 500 (so OpenAI retries) when accept fails, and allows the retry to re-claim', async () => {
    const { secret, accept, jobs, calls, post } = setup();
    accept.mockRejectedValueOnce(new Error('boom'));
    const body = incomingCallBody('call_G');
    const headers = signWebhook(secret, body);
    expect((await post(body, headers)).statusCode).toBe(500);
    expect(calls.get('call_G')?.status).toBe('failed');
    expect((await post(body, headers)).statusCode).toBe(200);
    expect(accept).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(1);
  });

  it('ignores other event types', async () => {
    const { secret, accept, post } = setup();
    const body = JSON.stringify({ object: 'event', id: 'evt_x', type: 'response.completed', created_at: 1, data: { id: 'resp_1' } });
    const res = await post(body, signWebhook(secret, body));
    expect(res.statusCode).toBe(200);
    expect(accept).not.toHaveBeenCalled();
  });
});

describe('caller recognition', () => {
  const crm = (delayMs: number) => ({
    findContactByPhone: async () => { await new Promise((r) => setTimeout(r, delayMs)); return { id: '42', firstName: 'Jordan' }; },
    lastNote: async () => ({ body: 'Door replacement', at: '2026-08-21T23:53:00Z' }),
    upsertContact: async () => { throw new Error('unused'); },
    addNote: async () => {}, addTask: async () => {},
  });

  async function run(lookupDelay: number, timeout: number) {
    const secret = makeWebhookSecret();
    const openai = createOpenAI({ OPENAI_API_KEY: 'sk-test', OPENAI_WEBHOOK_SECRET: secret });
    const accept = vi.spyOn(openai.realtime.calls, 'accept').mockResolvedValue(undefined as never);
    const jobs: SessionJob[] = [];
    const handler = createWebhookHandler({
      secrets: async () => ({ OPENAI_API_KEY: 'sk-test', OPENAI_WEBHOOK_SECRET: secret }),
      openai: () => openai,
      store: () => memoryStore([{ ...TENANT, crm: { type: 'hubspot' } }]),
      startSession: async (job) => { jobs.push(job); },
      crmFor: async () => crm(lookupDelay),
      lookupTimeoutMs: timeout,
      log: silentLog,
    });
    const body = incomingCallBody('call_K');
    const event = { body, isBase64Encoded: false, headers: { 'content-type': 'application/json', ...signWebhook(secret, body) } } as unknown as APIGatewayProxyEventV2;
    const res = (await handler(event, {} as never, () => {})) as APIGatewayProxyStructuredResultV2;
    return { res, accept, jobs };
  }

  it('injects the known caller into accept instructions and the session job', async () => {
    const { res, accept, jobs } = await run(5, 500);
    expect(res.statusCode).toBe(200);
    const params = accept.mock.calls[0]![1] as { instructions?: string };
    expect(params.instructions).toContain('## Caller ID');
    expect(params.instructions).toContain('Jordan');
    expect(jobs[0]?.extras?.knownCaller).toMatchObject({ contactId: '42', name: 'Jordan', lastNote: 'Door replacement' });
  });

  it('accepts without it when the CRM is slow', async () => {
    const { res, accept, jobs } = await run(300, 30);
    expect(res.statusCode).toBe(200);
    const params = accept.mock.calls[0]![1] as { instructions?: string };
    expect(params.instructions).toContain('## Caller ID'); // caller-id number is always present
    expect(params.instructions).not.toContain('matches an existing contact'); // ...but no CRM match
    expect(jobs[0]?.extras?.knownCaller).toBeUndefined();
    expect(jobs[0]?.extras?.callerPhone).toBe('+15555550123');
  });
});
