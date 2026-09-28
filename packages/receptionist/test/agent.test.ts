import { describe, expect, it } from 'vitest';
import { buildInstructions, enabledTools, greeting, handlers, spokenPhone, type CallContext } from '../src/agent.js';
import { memoryPublisher } from '@wnk/shared';
import { memoryStore } from '@wnk/shared';
import { TenantConfigSchema } from '@wnk/shared';
import { silentLog, TENANT } from './helpers.js';

const parse = (t: object) => TenantConfigSchema.parse(t);

describe('tenant config', () => {
  it('applies defaults', () => {
    const t = parse(TENANT);
    expect(t.receptionist.session.model).toBe('gpt-realtime-2.1');
    expect(t.receptionist.session.audio.output.voice).toBe('marin');
    expect(t.receptionist.session.tools).toEqual(['record_lead', 'notify_owner', 'end_call']);
    expect(t.receptionist.maxCallSeconds).toBe(600);
    expect(t.emailResponder.enabled).toBe(false);
    expect(t.active).toBe(true);
  });
  it('rejects bad phone numbers and calls beyond the Lambda ceiling', () => {
    expect(() => parse({ ...TENANT, phoneNumber: '555-0100' })).toThrow();
    expect(() => parse({ ...TENANT, receptionist: { maxCallSeconds: 900 } })).toThrow();
  });
});

describe('prompt', () => {
  it('includes extra instructions', () => {
    expect(buildInstructions(parse({ ...TENANT, receptionist: { instructions: { extra: 'Always mention the spring promo.' } } }))).toContain('spring promo');
  });
  it('scopes the agent to the business and states the time limit', () => {
    const text = buildInstructions(parse({ ...TENANT, receptionist: { maxCallSeconds: 300 } }));
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

  it('record_lead publishes lead.recorded carrying the lead', async () => {
    const { c, events } = ctx();
    const res = await handlers.record_lead({ caller_name: 'Sam', phone: '(555) 555-0111', reason: 'leaky faucet' }, c);
    expect(res.ok).toBe(true);
    expect(events.events[0]).toMatchObject({
      type: 'lead.recorded', tenantId: 'acme', callId: 'call_1',
      lead: { leadId: res.lead_id, tenantId: 'acme', callId: 'call_1', callerName: 'Sam', phone: '+15555550111', reason: 'leaky faucet' },
    });
  });
  it('record_lead falls back to caller id when no phone given', async () => {
    const { c, events } = ctx();
    await handlers.record_lead({ caller_name: 'Sam', reason: 'x' }, c);
    expect(events.events[0]).toMatchObject({ type: 'lead.recorded', lead: { phone: '+15555550123' } });
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

describe('booking', () => {
  const CAL = { ...TENANT, calendar: { enabled: true, slotMinutes: 30, open: { start: '09:00', end: '11:00', days: [1, 2, 3, 4, 5] } }, receptionist: { session: { tools: ['record_lead', 'notify_owner', 'end_call', 'check_availability', 'book_appointment'] } } };
  const now = () => new Date('2026-09-28T15:00:00Z'); // Monday 8:00 Pacific
  function ctx(t: object, busy: (() => Promise<{ start: string; end: string }[]>) | undefined) {
    const events = memoryPublisher();
    const calls: unknown[][] = [];
    const c: CallContext = {
      tenant: parse(t), callId: 'call_1', party: { from: '+15555550123', to: '+15555550100' }, store: memoryStore(), events, log: silentLog, requestHangup: () => {}, now,
      ...(busy ? { calendar: { busy: async (...args: unknown[]) => { calls.push(args); return busy(); } } } : {}),
    };
    return { c, events, calls };
  }

  it('check_availability asks free/busy for the tenant, its calendar, and the day, and answers the open slots', async () => {
    const { c, calls } = ctx(CAL, async () => [{ start: '2026-09-30T16:00:00Z', end: '2026-09-30T16:30:00Z' }]);
    const res = await handlers.check_availability({ date: '2026-09-30' }, c);
    expect(calls).toEqual([['acme', 'primary', '2026-09-30T07:00:00.000Z', '2026-10-01T07:00:00.000Z']]);
    expect(res).toEqual({ ok: true, day: 'Wednesday, September 30', slots: [{ start: '2026-09-30T09:30', time: '9:30 AM' }, { start: '2026-09-30T10:00', time: '10:00 AM' }, { start: '2026-09-30T10:30', time: '10:30 AM' }] });
  });
  it('answers that booking is unavailable when the tenant has no calendar, the session no access, or the read fails', async () => {
    expect((await handlers.check_availability({ date: '2026-09-30' }, ctx(TENANT, async () => []).c)).ok).toBe(false);
    expect((await handlers.check_availability({ date: '2026-09-30' }, ctx(CAL, undefined).c)).ok).toBe(false);
    expect((await handlers.check_availability({ date: '2026-09-30' }, ctx(CAL, async () => { throw new Error('timeout'); }).c)).ok).toBe(false);
    expect((await handlers.check_availability({ date: 'wednesday' }, ctx(CAL, async () => []).c)).ok).toBe(false);
  });
  it('book_appointment publishes the slot as an instant and a wall-clock time, with the caller', async () => {
    const { c, events } = ctx(CAL, async () => []);
    const res = await handlers.book_appointment({ start: '2026-09-30T10:00', caller_name: 'Sam Lee', phone: '(555) 555-0111', reason: 'a quote', email: 'sam@example.com' }, c);
    expect(res).toMatchObject({ ok: true, when: 'Wednesday, September 30 at 10:00 AM', confirmation: 'a text will confirm it' });
    expect(events.events[0]).toMatchObject({
      type: 'appointment.requested', tenantId: 'acme', tenantPhoneNumber: '+15555550100', callId: 'call_1',
      appointment: { tenantId: 'acme', callId: 'call_1', callerName: 'Sam Lee', phone: '+15555550111', email: 'sam@example.com', reason: 'a quote', startsAt: '2026-09-30T17:00:00.000Z', endsAt: '2026-09-30T17:30:00.000Z', local: '2026-09-30T10:00', timezone: 'America/Los_Angeles', durationMinutes: 30 },
    });
  });
  it('book_appointment refuses a time off the grid, outside the hours, in the past, or on a closed day, and publishes nothing', async () => {
    for (const start of ['2026-09-30T10:15', '2026-09-30T14:00', '2026-09-28T07:00', '2026-10-03T10:00']) {
      const { c, events } = ctx(CAL, async () => []);
      expect((await handlers.book_appointment({ start, caller_name: 'Sam', reason: 'x' }, c)).ok).toBe(false);
      expect(events.events).toEqual([]);
    }
  });
  it('the prompt teaches booking only when the calendar is on and both tools are listed', () => {
    const text = buildInstructions(parse(CAL), {}, undefined, now());
    expect(text).toContain('call `check_availability` for that day');
    expect(text).toContain('Right now it is Monday, September 28, 2026 at 8:00 AM (America/Los_Angeles)');
    expect(text).not.toContain('cannot book');
    expect(buildInstructions(parse(TENANT))).toContain('You cannot book, reschedule, or cancel appointments yet');
    expect(buildInstructions(parse({ ...CAL, calendar: { enabled: false } }))).toContain('You cannot book, reschedule, or cancel appointments yet');
    expect(enabledTools(parse(CAL))).toEqual(['record_lead', 'notify_owner', 'end_call', 'check_availability', 'book_appointment']);
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
    const t = parse({ ...TENANT, receptionist: { greeting: 'Thanks for calling Acme, this is Alex. How can I help you today?' } });
    expect(greeting(t)).toBe('Thanks for calling Acme, this is Alex. How can I help you today?');
    expect(greeting(t, { knownCaller: { contactId: '1', name: 'Jordan Rivera' } })).toBe('Thanks for calling Acme, this is Alex. Am I speaking with Jordan?');
    expect(greeting(parse(TENANT), { knownCaller: { contactId: '1', name: 'Sam' } })).toBe('Thanks for calling Acme Plumbing, this is Alex. Am I speaking with Sam?');
  });
});
