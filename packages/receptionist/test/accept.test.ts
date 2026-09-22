/** Accept: the tenant from the called number and nothing else, the claim, recognition that can lose the race but never the call, the accept, the job. */
import { describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '@wnk/shared';
import { TenantConfigSchema } from '@wnk/shared';
import { SIP_CALLED_HEADERS, SIP_CALLER_HEADERS, createAccept, htmlToText, sipNumber, type AcceptDeps, type IncomingCall } from '../src/accept.js';
import { TENANT } from './helpers.js';

describe('sipNumber', () => {
  const to = (h: { name: string; value: string }[]) => sipNumber(h, SIP_CALLED_HEADERS);
  const from = (h: { name: string; value: string }[]) => sipNumber(h, SIP_CALLER_HEADERS);
  it('Twilio: To carries the project id, Diversion the dialed number', () => {
    const headers = [
      { name: 'From', value: '<sip:+15555550155@pstn.twilio.com>;tag=abc' },
      { name: 'To', value: '<sip:proj_ABC@sip.api.openai.com;transport=tls>' },
      { name: 'Diversion', value: '<sip:+15555550100@twilio.com>;reason=unconditional' },
    ];
    expect(to(headers)).toBe('+15555550100');
    expect(from(headers)).toBe('+15555550155');
  });
  it('plain sip: URIs, tel: URIs, bare numbers, and header-name case', () => {
    expect(to([{ name: 'to', value: 'sip:15555550100@host' }])).toBe('+15555550100');
    expect(from([{ name: 'P-Asserted-Identity', value: 'tel:+1 (555) 555-0123' }])).toBe('+15555550123');
    expect(to([{ name: 'X-Called-Number', value: '555-555-0100' }])).toBe('+5555550100'); // bare numbers are not given a country code
  });
  it("'' when no header carries a number, or the number is not a phone number", () => {
    expect(to([{ name: 'To', value: 'sip:proj_ABC@sip.api.openai.com' }])).toBe('');
    expect(from([{ name: 'Call-ID', value: 'abc' }])).toBe('');
    expect(to([])).toBe('');
    expect(to([{ name: 'To', value: 'sip:12345@host' }])).toBe('');
  });
  it('strips note HTML to one line', () => {
    expect(htmlToText('Call to <b>WNK</b> line<br><br>Agent: hi<br>Caller:  yo')).toBe('Call to WNK line Agent: hi Caller: yo');
  });
});

const tenant: TenantConfig = TenantConfigSchema.parse({ ...TENANT, crm: { type: 'hubspot', via: 'composio' } });
const call = (overrides: Partial<IncomingCall['data']> = {}): IncomingCall => ({
  type: 'realtime.call.incoming', id: 'evt_1',
  data: { call_id: 'rtc_1', sip_headers: [{ name: 'From', value: 'sip:+15555550123@x' }, { name: 'To', value: 'sip:+15555550100@x' }], ...overrides },
});
type Fakes = { [K in keyof Omit<AcceptDeps, 'crm' | 'now'>]: ReturnType<typeof vi.fn<AcceptDeps[K]>> } & { crm: { account: ReturnType<typeof vi.fn<AcceptDeps['crm']['account']>>; proxy: ReturnType<typeof vi.fn<AcceptDeps['crm']['proxy']>> } };
const fakes = (): Fakes => ({
  lookupTenant: vi.fn(async () => tenant), claim: vi.fn(async () => true), setStatus: vi.fn(async () => undefined),
  crm: { account: vi.fn(async () => 'acct'), proxy: vi.fn(async () => ({ results: [] })) },
  recallMemory: vi.fn(async () => []), openai: vi.fn(async () => 200), enqueue: vi.fn(async () => undefined),
});
const run = (f: Fakes, event = call()) => createAccept({ ...f, now: () => new Date('2026-09-22T00:00:00Z') })(event);

describe('accept', () => {
  it('claims, recognizes the caller from the CRM and memory, accepts, and enqueues the job with what it found', async () => {
    const f = fakes();
    f.crm.proxy
      .mockResolvedValueOnce({ results: [{ id: 9, properties: { firstname: 'Sam', lastname: 'K' } }] })
      .mockResolvedValueOnce({ results: [{ properties: { hs_note_body: 'Asked about <b>drains</b>', hs_createdate: '2026-09-01' } }] });
    f.recallMemory.mockResolvedValue(['prefers mornings']);
    expect(await run(f)).toBe('accepted');
    expect(f.lookupTenant).toHaveBeenCalledWith('+15555550100');
    expect(f.claim).toHaveBeenCalledWith(expect.objectContaining({ callId: 'rtc_1', tenantId: 'acme', to: '+15555550100', from: '+15555550123', webhookId: 'evt_1' }));
    expect(f.openai).toHaveBeenCalledWith('rtc_1', 'accept', expect.objectContaining({ type: 'realtime', model: 'gpt-realtime-2.1', audio: { output: { voice: 'marin' } } }));
    expect(f.setStatus).toHaveBeenCalledWith('rtc_1', 'accepted');
    expect(f.enqueue).toHaveBeenCalledWith({
      callId: 'rtc_1', tenantPhoneNumber: '+15555550100', startedAt: '2026-09-22T00:00:00.000Z', to: '+15555550100', from: '+15555550123',
      extras: { callerPhone: '+15555550123', knownCaller: { contactId: '9', name: 'Sam K', lastNote: 'Asked about drains', lastNoteAt: '2026-09-01' }, callerMemory: ['prefers mornings'] },
    });
  });

  it('recognition that fails or times out is left out; the call is still accepted', async () => {
    const f = fakes();
    f.crm.account.mockRejectedValue(new Error('slow'));
    f.recallMemory.mockRejectedValue(new Error('slow'));
    expect(await run(f)).toBe('accepted');
    expect((f.enqueue.mock.calls[0]?.[0])?.extras).toEqual({ callerPhone: '+15555550123' });
  });

  it('a caller without a number gets no recognition and no CRM call', async () => {
    const f = fakes();
    expect(await run(f, call({ sip_headers: [{ name: 'To', value: 'sip:+15555550100@x' }] }))).toBe('accepted');
    expect(f.crm.account).not.toHaveBeenCalled();
    expect(f.recallMemory).not.toHaveBeenCalled();
    expect((f.enqueue.mock.calls[0]?.[0])?.extras).toEqual({});
  });

  it('an unknown called number is rejected 404 and thrown; an inactive tenant is rejected 603 and done', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue(undefined);
    await expect(run(f)).rejects.toThrow(/UnknownCalledNumber/);
    expect(f.openai).toHaveBeenCalledWith('rtc_1', 'reject', { status_code: 404 });
    expect(f.claim).not.toHaveBeenCalled();
    const g = fakes();
    g.lookupTenant.mockResolvedValue({ ...tenant, active: false });
    expect(await run(g)).toBe('inactive');
    expect(g.openai).toHaveBeenCalledWith('rtc_1', 'reject', { status_code: 603 });
  });

  it('a duplicate webhook ends at the claim', async () => {
    const f = fakes();
    f.claim.mockResolvedValue(false);
    expect(await run(f)).toBe('duplicate');
    expect(f.openai).not.toHaveBeenCalled();
  });

  it('a call gone before accept is marked and not paged; any other refusal is marked and thrown', async () => {
    const f = fakes();
    f.openai.mockResolvedValue(404);
    expect(await run(f)).toBe('gone');
    expect(f.setStatus).toHaveBeenCalledWith('rtc_1', 'failed', 'call gone before accept');
    expect(f.enqueue).not.toHaveBeenCalled();
    const g = fakes();
    g.openai.mockResolvedValue(500);
    await expect(run(g)).rejects.toThrow(/AcceptFailed/);
    expect(g.setStatus).toHaveBeenCalledWith('rtc_1', 'failed', 'accept failed');
  });

  it('ignores anything but an incoming call', async () => {
    const f = fakes();
    expect(await run(f, { type: 'realtime.call.ended', id: 'x' })).toBe('ignored');
    expect(f.lookupTenant).not.toHaveBeenCalled();
  });
});
