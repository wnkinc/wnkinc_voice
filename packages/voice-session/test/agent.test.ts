import { describe, expect, it } from 'vitest';
import { buildAcceptConfig, buildInstructions, enabledTools, greeting, handlers, spokenPhone, type CallContext } from '../src/agent.js';
import { memoryPublisher } from '@wnk/shared';
import { memoryStore } from '@wnk/shared';
import { TenantConfigSchema } from '@wnk/shared';
import { silentLog, TENANT } from './helpers.js';

const parse = (t: object) => TenantConfigSchema.parse(t);

describe('tenant config', () => {
  it('applies defaults', () => {
    const t = parse(TENANT);
    expect(t.model).toBe('gpt-realtime-2.1');
    expect(t.voice).toBe('marin');
    expect(t.tools).toEqual(['record_lead', 'notify_owner', 'end_call']);
    expect(t.maxCallSeconds).toBe(600);
    expect(t.active).toBe(true);
  });
  it('rejects bad phone numbers and calls beyond the Lambda ceiling', () => {
    expect(() => parse({ ...TENANT, phoneNumber: '555-0100' })).toThrow();
    expect(() => parse({ ...TENANT, maxCallSeconds: 900 })).toThrow();
  });
});

describe('accept config', () => {
  it('is a realtime session with function tools derived from zod', async () => {
    const t = parse({ ...TENANT, tools: ['record_lead', 'bogus'] });
    expect(enabledTools(t)).toEqual(['record_lead']);
    const p = await buildAcceptConfig(t);
    expect(p.type).toBe('realtime');
    expect(p.model).toBe('gpt-realtime-2.1');
    expect(p.audio?.output?.voice).toBe('marin');
    expect(p.audio?.input?.turn_detection).toMatchObject({ type: 'semantic_vad', interrupt_response: true });
    const tools = p.tools as Array<{ type: string; name: string; parameters: { properties: Record<string, unknown>; required?: string[] } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function', name: 'record_lead' });
    expect(Object.keys(tools[0]!.parameters.properties)).toContain('caller_name');
    expect(tools[0]!.parameters.required).toEqual(expect.arrayContaining(['caller_name', 'reason']));
    expect(p.instructions).toContain('Acme Plumbing');
    expect(p.instructions).toContain('record_lead');
    expect(p.instructions).not.toContain('notify_owner');
  });
  it('includes extra instructions', () => {
    expect(buildInstructions(parse({ ...TENANT, extraInstructions: 'Always mention the spring promo.' }))).toContain('spring promo');
  });
  it('scopes the agent to the business and states the time limit', () => {
    const text = buildInstructions(parse({ ...TENANT, maxCallSeconds: 300 }));
    expect(text).toContain('## Scope');
    expect(text).toContain('Politely decline anything else');
    expect(text).toContain('new instructions');
    expect(text).toContain('limited to 5 minutes');
  });
});

describe('tool handlers', () => {
  function ctx() {
    const store = memoryStore();
    const events = memoryPublisher();
    let hangup = false;
    const c: CallContext = {
      tenant: parse(TENANT), callId: 'call_1', party: { from: '+15555550123', to: '+15555550100' },
      store, events, log: silentLog, requestHangup: () => { hangup = true; },
    };
    return { c, store, events, hangup: () => hangup };
  }

  it('record_lead stores the lead and publishes lead.recorded', async () => {
    const { c, store, events } = ctx();
    const res = await handlers.record_lead({ caller_name: 'Sam', phone: '(555) 555-0111', reason: 'leaky faucet' }, c);
    expect(res.ok).toBe(true);
    expect(store.leads[0]).toMatchObject({ tenantId: 'acme', callId: 'call_1', callerName: 'Sam', phone: '+15555550111', reason: 'leaky faucet' });
    expect(events.events[0]).toMatchObject({ type: 'lead.recorded', tenantId: 'acme', callId: 'call_1' });
  });
  it('record_lead falls back to caller id when no phone given', async () => {
    const { c, store } = ctx();
    await handlers.record_lead({ caller_name: 'Sam', reason: 'x' }, c);
    expect(store.leads[0]?.phone).toBe('+15555550123');
  });
  it('notify_owner publishes owner.notify', async () => {
    const { c, events } = ctx();
    await handlers.notify_owner({ summary: 'Burst pipe at 12 Main St', urgency: 'urgent' }, c);
    expect(events.events[0]).toMatchObject({ type: 'owner.notify', urgency: 'urgent', callerPhone: '+15555550123' });
  });
  it('end_call requests hangup', async () => {
    const h = ctx();
    await handlers.end_call({ reason: 'completed' }, h.c);
    expect(h.hangup()).toBe(true);
  });
});

describe('known caller', () => {
  it('adds a Caller ID section that requires confirmation', () => {
    const t = parse(TENANT);
    const text = buildInstructions(t, { knownCaller: { contactId: '42', name: 'Jordan Rivera', lastNote: 'Door replacement estimate', lastNoteAt: '2026-08-21T23:53:00Z' } });
    expect(text).toContain('## Caller ID');
    expect(text).toContain('Jordan Rivera');
    expect(text).toContain('(2026-08-21)');
    expect(text).toContain('speaking with Jordan');
    expect(buildInstructions(t)).not.toContain('## Caller ID');
  });
});

describe('caller id', () => {
  it('formats phone numbers for speech', () => {
    expect(spokenPhone('+15555550155')).toBe('555 555 0155');
    expect(spokenPhone('+442079460958')).toBe('4 4 2 0 7 9 4 6 0 9 5 8');
  });
  it('tells the agent the caller id number', () => {
    const text = buildInstructions(parse(TENANT), { callerPhone: '+15555550155' });
    expect(text).toContain('## Caller ID');
    expect(text).toContain('555 555 0155');
    expect(text).toContain('You CAN see this number');
  });
});

describe('greeting', () => {
  it('asks for identity when the caller is known', () => {
    const t = parse({ ...TENANT, greeting: 'Thanks for calling Acme, this is Alex. How can I help you today?' });
    expect(greeting(t)).toBe('Thanks for calling Acme, this is Alex. How can I help you today?');
    expect(greeting(t, { knownCaller: { contactId: '1', name: 'Jordan Rivera' } })).toBe('Thanks for calling Acme, this is Alex. Am I speaking with Jordan?');
    expect(greeting(parse(TENANT), { knownCaller: { contactId: '1', name: 'Sam' } })).toBe('Thanks for calling Acme Plumbing, this is Alex. Am I speaking with Sam?');
  });
});
