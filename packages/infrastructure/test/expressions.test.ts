import jsonata from 'jsonata';
import { describe, expect, it } from 'vitest';
import { htmlToTextExpr, sipNumberExpr, SIP_CALLED_HEADERS, SIP_CALLER_HEADERS } from '../workflows/accept.js';
import { loginSiteExpr } from '../workflows/browser-login.js';
import { expectedToolkitsExpr, missingToolkitsExpr } from '../workflows/composio-health.js';
import { nextBusinessMorningExpr } from '../workflows/crm-lead.js';

const evalExpr = (expr: string, input: unknown) => jsonata(expr).evaluate(input);

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

describe('nextBusinessMorningExpr', () => {
  // Pacific in September: zoneOffset -420 -> seed offset 600.
  const at = (iso: string) => evalExpr(nextBusinessMorningExpr('600', String(Date.parse(iso))), {});
  it('Friday afternoon -> Monday 09:00 PDT (16:00Z)', async () => { expect(await at('2026-09-04T22:00:00Z')).toBe('2026-09-07T16:00:00.000Z'); });
  it('Monday 08:59 local -> same day 09:00', async () => { expect(await at('2026-09-07T15:59:00Z')).toBe('2026-09-07T16:00:00.000Z'); });
  it('Monday 09:00 local -> Tuesday', async () => { expect(await at('2026-09-07T16:00:00Z')).toBe('2026-09-08T16:00:00.000Z'); });
  it('Saturday -> Monday', async () => { expect(await at('2026-09-05T18:00:00Z')).toBe('2026-09-07T16:00:00.000Z'); });
  it('Eastern (seed offset 420): Friday evening -> Monday 09:00 EDT (13:00Z)', async () => {
    expect(await evalExpr(nextBusinessMorningExpr('420', String(Date.parse('2026-09-04T23:00:00Z'))), {})).toBe('2026-09-07T13:00:00.000Z');
  });
});

describe('htmlToTextExpr', () => {
  it('strips tags and collapses whitespace', async () => {
    expect(await evalExpr(htmlToTextExpr('b'), { b: 'Call to <b>WNK</b> line<br><br>Agent: hi<br>Caller:  yo' })).toBe('Call to WNK line Agent: hi Caller: yo');
  });
});

describe('composio health expressions', () => {
  // `Bool`, as the aws-sdk scan integration this workflow reads with returns
  // it — not the optimized integration's `BOOL`. The fixture spelled it the
  // API way while the expression did too, so both were wrong and this test
  // stayed green while gmail went unchecked in production.
  const row = (crm: boolean, email: boolean) => ({ crm: crm ? { M: { type: { S: 'hubspot' }, via: { S: 'composio' } } } : undefined, emailResponder: { M: { enabled: { Bool: email } } } });
  it('expects hubspot for crm via composio and gmail for the email responder', async () => {
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(true, true) })).toEqual(['hubspot', 'gmail']);
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(true, false) })).toEqual(['hubspot']);
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(false, false) })).toEqual([]);
  });
  it('reports the expected toolkits Composio does not list as active', async () => {
    expect(await evalExpr(missingToolkitsExpr('expected', 'active'), { expected: ['hubspot', 'gmail'], active: ['gmail'] })).toEqual(['hubspot']);
    expect(await evalExpr(missingToolkitsExpr('expected', 'active'), { expected: ['hubspot'], active: ['hubspot', 'gmail'] })).toEqual([]);
    expect(await evalExpr(missingToolkitsExpr('expected', 'active'), { expected: ['hubspot'], active: [] })).toEqual(['hubspot']);
  });
});

describe('loginSiteExpr', () => {
  const site = (text: string) => evalExpr(loginSiteExpr('text'), { text });
  it('the words after /login, trimmed', async () => {
    expect(await site('/login supplier portal')).toBe('supplier portal');
    expect(await site('/login   https://portal.example.com ')).toBe('https://portal.example.com');
  });
  it("'' for a bare /login", async () => {
    expect(await site('/login')).toBe('');
    expect(await site('/login ')).toBe('');
  });
});
