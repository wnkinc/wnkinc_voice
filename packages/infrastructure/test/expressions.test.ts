import jsonata from 'jsonata';
import { describe, expect, it } from 'vitest';
import { htmlToTextExpr, sipNumberExpr, SIP_CALLED_HEADERS, SIP_CALLER_HEADERS } from '../workflows/accept.js';
import { loginSiteExpr } from '../workflows/browser-login.js';
import { expectedToolkitsExpr, missingToolkitsExpr } from '../workflows/composio-health.js';
import { nextBusinessMorningExpr } from '../workflows/crm-lead.js';
import { parseFormExpr } from '../workflows/sms.js';
import { ASSISTANT_TOOLS, callsExpr, historyExpr, outputsExpr, textExpr, toolResultExpr } from '../workflows/assistant-loop.js';
import { ASSISTANT_TOOL_NAMES } from '../../shared/src/types.js';

const evalExpr = (expr: string, input: unknown, bindings: Record<string, unknown> = {}) => {
  const e = jsonata(expr);
  // Step Functions adds $parse; the jsonata library has $eval instead. Same contract for JSON text.
  e.registerFunction('parse', (text: string) => JSON.parse(text) as unknown);
  return e.evaluate(input, bindings);
};

describe('assistant loop', () => {
  it('the tenant row may only name tools the catalog runs', () => {
    expect(Object.keys(ASSISTANT_TOOLS).sort()).toEqual([...ASSISTANT_TOOL_NAMES].sort());
  });
  // A Responses API body as OpenAI returned it in the spike (one tool call, no text), and one with text only.
  const toolTurn = { id: 'resp_1', output: [{ type: 'function_call', call_id: 'call_1', name: 'search_contacts', arguments: '{"query":"+15555550100"}' }], usage: { total_tokens: 157 } };
  const textTurn = { id: 'resp_2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Found one contact.' }] }], usage: { total_tokens: 198 } };
  it('reads tool calls and text from a Responses body', async () => {
    expect(await evalExpr(callsExpr('$b'), {}, { b: toolTurn })).toEqual(toolTurn.output);
    expect(await evalExpr(callsExpr('$b'), {}, { b: textTurn })).toEqual([]);
    expect(await evalExpr(textExpr('$b'), {}, { b: toolTurn })).toBe('');
    expect(await evalExpr(textExpr('$b'), {}, { b: textTurn })).toBe('Found one contact.');
  });
  it('shapes a Composio result for the model, bounded, and carries the error when it failed', async () => {
    const ok = { successful: true, data: { total: 1, results: [{ id: '9', properties: { firstname: 'Composio', lastname: null, phone: '+15555550100', email: null } }] } };
    const shaped = await evalExpr(toolResultExpr('$r', ASSISTANT_TOOLS.search_contacts.shape), {}, { r: ok, callId: 'call_1' }) as { call_id: string; output: string };
    expect(shaped.call_id).toBe('call_1');
    expect(JSON.parse(shaped.output)).toEqual({ total: 1, contacts: [{ id: '9', name: 'Composio', phone: '+15555550100', email: null }] });
    const failed = await evalExpr(toolResultExpr('$r', ASSISTANT_TOOLS.search_contacts.shape), {}, { r: { successful: false, error: 'no HubSpot connection' }, callId: 'call_1' }) as { output: string };
    expect(JSON.parse(failed.output)).toEqual({ error: 'no HubSpot connection' });
    const big = { successful: true, data: { total: 1, results: [{ id: 'x'.repeat(7000), properties: {} }] } };
    const cut = await evalExpr(toolResultExpr('$r', ASSISTANT_TOOLS.search_contacts.shape), {}, { r: big, callId: 'c' }) as { output: string };
    expect(cut.output.endsWith('...[truncated]')).toBe(true);
    expect(cut.output.length).toBeLessThan(6100);
  });
  it('turns tool results into the next round and session events into history, oldest first', async () => {
    expect(await evalExpr(outputsExpr('$results'), {}, { results: [{ call_id: 'c1', output: '{"total":0}' }] })).toEqual([{ type: 'function_call_output', call_id: 'c1', output: '{"total":0}' }]);
    const events = [
      { EventTimestamp: '2026-09-16T21:10:00Z', Payload: [{ Conversational: { Role: 'USER', Content: { Text: 'second' } } }] },
      { EventTimestamp: '2026-09-16T21:00:00Z', Payload: [{ Conversational: { Role: 'USER', Content: { Text: 'first' } } }, { Conversational: { Role: 'ASSISTANT', Content: { Text: 'reply' } } }] },
    ];
    expect(await evalExpr(historyExpr('$e'), {}, { e: events })).toEqual([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'second' }]);
    expect(await evalExpr(historyExpr('$e'), {}, { e: [] })).toEqual([]);
  });
});

describe('parseFormExpr', () => {
  const parse = (body: string) => evalExpr(parseFormExpr('body'), { body });
  it('decodes a Twilio inbound message: %2B stays a plus, + becomes a space, %xx decodes', async () => {
    expect(await parse('From=%2B15095551234&To=%2B15098005349&Body=who+is+Sarah%3F+%22hi%22&AccountSid=AC123&NumMedia=0')).toEqual({
      From: '+15095551234', To: '+15098005349', Body: 'who is Sarah? "hi"', AccountSid: 'AC123', NumMedia: '0',
    });
  });
  it('empty values and an empty body', async () => {
    expect(await parse('Body=&NumMedia=1')).toEqual({ Body: '', NumMedia: '1' });
    expect(await parse('')).toEqual({ '': '' });
  });
});

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
