import jsonata from 'jsonata';
import { describe, expect, it } from 'vitest';
import { htmlToTextExpr, sipNumberExpr, SIP_CALLED_HEADERS, SIP_CALLER_HEADERS } from '../workflows/receptionist/accept.js';

const evalExpr = (expr: string, input: unknown, bindings: Record<string, unknown> = {}) => {
  const e = jsonata(expr);
  // Step Functions adds $parse; the jsonata library has $eval instead. Same contract for JSON text.
  e.registerFunction('parse', (text: string) => JSON.parse(text) as unknown);
  return e.evaluate(input, bindings);
};

describe('sipNumberExpr', () => {
  const to = sipNumberExpr('sip_headers', SIP_CALLED_HEADERS);
  const from = sipNumberExpr('sip_headers', SIP_CALLER_HEADERS);
  it('Twilio: To carries the project id, Diversion the dialed number', async () => {
    const headers = [
      { name: 'From', value: '<sip:+15555550155@pstn.twilio.com>;tag=abc' },
      { name: 'To', value: '<sip:proj_ABC@sip.api.openai.com;transport=tls>' },
      { name: 'Diversion', value: '<sip:+15555550100@twilio.com>;reason=unconditional' },
    ];
    expect(await evalExpr(to, { sip_headers: headers })).toBe('+15555550100');
    expect(await evalExpr(from, { sip_headers: headers })).toBe('+15555550155');
  });
  it('plain sip: URIs, tel: URIs, bare numbers, and header-name case', async () => {
    expect(await evalExpr(to, { sip_headers: [{ name: 'to', value: 'sip:15555550100@host' }] })).toBe('+15555550100');
    expect(await evalExpr(from, { sip_headers: [{ name: 'P-Asserted-Identity', value: 'tel:+1 (555) 555-0123' }] })).toBe('+15555550123');
    expect(await evalExpr(to, { sip_headers: [{ name: 'X-Called-Number', value: '555-555-0100' }] })).toBe('+5555550100'); // parity with the old parser: bare numbers are not given a country code
  });
  it("'' when no header carries a number, or the number is not a phone number", async () => {
    expect(await evalExpr(to, { sip_headers: [{ name: 'To', value: 'sip:proj_ABC@sip.api.openai.com' }] })).toBe('');
    expect(await evalExpr(from, { sip_headers: [{ name: 'Call-ID', value: 'abc' }] })).toBe('');
    expect(await evalExpr(to, { sip_headers: [] })).toBe('');
    expect(await evalExpr(to, { sip_headers: [{ name: 'To', value: 'sip:12345@host' }] })).toBe('');
  });
  it('one header only (JSONata singleton)', async () => {
    expect(await evalExpr(to, { sip_headers: [{ name: 'Diversion', value: '<sip:+15555550100@twilio.com>' }] })).toBe('+15555550100');
  });
});

describe('htmlToTextExpr', () => {
  it('strips tags and collapses whitespace', async () => {
    expect(await evalExpr(htmlToTextExpr('b'), { b: 'Call to <b>WNK</b> line<br><br>Agent: hi<br>Caller:  yo' })).toBe('Call to WNK line Agent: hi Caller: yo');
  });
});

