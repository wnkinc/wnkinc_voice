import jsonata from 'jsonata';
import { describe, expect, it } from 'vitest';
import { htmlToTextExpr, sipNumberExpr, SIP_CALLED_HEADERS, SIP_CALLER_HEADERS } from '../workflows/receptionist/accept.js';
import { loginSiteExpr } from '../workflows/assistant/browser-login.js';
import { expectedToolkitsExpr, missingToolkitsExpr } from '../workflows/canaries/composio-health.js';
import { nextBusinessMorningExpr } from '../workflows/automations/crm-lead.js';
import { allowedToolsExpr, mediaExpr, parseFormExpr, textOrPhotosExpr } from '../workflows/assistant/sms.js';
import { APPROVAL_WORD, contentExpr, draftMessageExpr, FACEBOOK_TOOLS, isApprovalExpr, nextMediaExpr, pendingExpr, postIdExpr } from '../workflows/assistant/facebook-post.js';
import { ASSISTANT_TOOLS, callsExpr, historyExpr, outputsExpr, textExpr, toolResultExpr } from '../workflows/assistant/assistant-loop.js';
import { ACTION_APPROVAL_WORDS, ASSISTANT_TOOL_NAMES } from '../../shared/src/types.js';

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
  const row = (crm: boolean, email: boolean, facebook = false) => ({ crm: crm ? { M: { type: { S: 'hubspot' }, via: { S: 'composio' } } } : undefined, emailResponder: { M: { enabled: { Bool: email } } }, facebookPosts: { M: { enabled: { Bool: facebook } } } });
  it('expects hubspot for crm via composio and gmail for the email responder', async () => {
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(true, true) })).toEqual(['hubspot', 'gmail']);
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(true, false) })).toEqual(['hubspot']);
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(false, false) })).toEqual([]);
  });
  it('expects facebook for Facebook posts, and nothing for a row written before the service existed', async () => {
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(true, true, true) })).toEqual(['hubspot', 'gmail', 'facebook']);
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: row(false, false, true) })).toEqual(['facebook']);
    expect(await evalExpr(expectedToolkitsExpr('row'), { row: { emailResponder: { M: { enabled: { Bool: true } } } } })).toEqual(['gmail']);
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

describe('facebook posts', () => {
  const photo = (n: string) => ({ M: { messageSid: { S: 'MM1' }, mediaSid: { S: `ME${n}` } } });
  const sms = (media: [string, string][], body = 'post this') => ({
    Body: body, MessageSid: 'MM1', NumMedia: String(media.length),
    ...Object.fromEntries(media.flatMap(([type, id], i) => [[`MediaContentType${i}`, type], [`MediaUrl${i}`, `https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME${id}`]])),
  });

  it('the approval word is the one the ledger names, and the tools are ones a row may list', () => {
    expect(APPROVAL_WORD).toBe(ACTION_APPROVAL_WORDS.facebook_post);
    for (const t of FACEBOOK_TOOLS) expect(ASSISTANT_TOOL_NAMES).toContain(t);
  });

  it('reads the texted photos as a list of Twilio ids: none, one, several, images only', async () => {
    // A variable, as in the workflow: inside the per-photo step the context is the index, not the message.
    const media = (message: unknown) => evalExpr(mediaExpr('$sms'), {}, { sms: message });
    expect(await media(sms([]))).toEqual([]);
    expect(await media({ Body: 'hi' })).toEqual([]);
    expect(await media(sms([['image/jpeg', 'a']]))).toEqual([photo('a')]);
    expect(await media(sms([['image/jpeg', 'a'], ['video/mp4', 'v'], ['image/png', 'b']]))).toEqual([photo('a'), photo('b')]);
    expect(await media(sms([['video/mp4', 'v']]))).toEqual([]);
  });
  it('a photo sent alone still has text for the model', async () => {
    expect(await evalExpr(textOrPhotosExpr('sms'), { sms: sms([['image/jpeg', 'a']], ' ') })).toBe('Sent 1 photos with no text.');
    expect(await evalExpr(textOrPhotosExpr('sms'), { sms: sms([['image/jpeg', 'a']], 'post this') })).toBe('post this');
  });

  // The approval: nothing but the word, on the revision the person was shown.
  const draft = (revision: number, shown: number) => ({ sk: { S: 'sms:+1#facebook_post#t#1' }, revision: { N: String(revision) }, shownRevision: { N: String(shown) } });
  const approves = (inboundText: string, d: unknown) => evalExpr(isApprovalExpr, {}, { inboundText, draft: d });
  it('only the whole word approves, in any case, with stray spaces', async () => {
    for (const text of ['POST', 'post', ' Post \n']) expect(await approves(text, draft(2, 2))).toBe(true);
    for (const text of ['post it', 'yes', 'YES POST', 'POST.', 'go ahead and post', '']) expect(await approves(text, draft(2, 2))).toBe(false);
  });
  it('approves nothing without a draft, or on a revision the person has not been shown', async () => {
    expect(await approves('POST', {})).toBe(false);
    expect(await approves('POST', draft(3, 2))).toBe(false);
    expect(await approves('POST', draft(1, 0))).toBe(false);
  });
  it('takes the newest pending row of a query, or {}', async () => {
    expect(await evalExpr(pendingExpr('r'), { r: { Count: 0, Items: [] } })).toEqual({});
    expect(await evalExpr(pendingExpr('r'), { r: { Count: 2, Items: [draft(2, 2), draft(1, 1)] } })).toEqual(draft(2, 2));
  });

  // Always a list: DynamoDB refuses an L that is a bare object, and JSONata unwraps a one-item array.
  const next = (photos: string, existing: unknown[] | undefined, media: unknown[]) =>
    evalExpr(nextMediaExpr('$row.payload.M.media.L'), {}, { a: { photos }, media, row: existing ? { payload: { M: { media: { L: existing } } } } : {} });
  it('applies the model\'s photos choice to the draft', async () => {
    expect(await next('use_new', [photo('old')], [photo('new')])).toEqual([photo('new')]);
    expect(await next('add_new', [photo('old')], [photo('new')])).toEqual([photo('old'), photo('new')]);
    expect(await next('keep', [photo('old')], [photo('new')])).toEqual([photo('old')]);
    expect(await next('none', [photo('old')], [photo('new')])).toEqual([]);
  });
  it('a new draft has no photos to keep, and an empty message adds none', async () => {
    expect(await next('keep', undefined, [photo('new')])).toEqual([]);
    expect(await next('add_new', undefined, [photo('new')])).toEqual([photo('new')]);
    expect(await next('use_new', undefined, [])).toEqual([]);
    expect(await next('add_new', [photo('a'), photo('b')], [])).toEqual([photo('a'), photo('b')]);
  });

  it('states the Page, the caption word for word, the photos, and the word that publishes', async () => {
    const tenant = { facebookPosts: { M: { pageName: { S: 'Deck Co' } } } };
    const row = (media: unknown[]) => ({ payload: { M: { caption: { S: 'Cedar deck, finished today.' }, media: { L: media } } } });
    const text = await evalExpr(draftMessageExpr('$shown'), {}, { tenant, shown: row([photo('a'), photo('b')]) }) as string;
    expect(text).toContain('Draft for the Facebook Page Deck Co:\n\nCedar deck, finished today.\n\n');
    expect(text).toContain('With the 2 photos you sent. Reply POST to publish it');
    expect(await evalExpr(draftMessageExpr('$shown'), {}, { tenant, shown: row([photo('a')]) })).toContain('With the 1 photo you sent.');
    expect(await evalExpr(draftMessageExpr('$shown'), {}, { tenant, shown: row([]) })).toContain('No photos.');
  });
  it('reads the post id from either tool shape', async () => {
    expect(await evalExpr(postIdExpr('b'), { b: { data: { id: 'photo1', post_id: 'page_post1' } } })).toBe('page_post1');
    expect(await evalExpr(postIdExpr('b'), { b: { data: { id: 'page_post2' } } })).toBe('page_post2');
  });
  it('gives the model the photos when their links were minted, the text alone otherwise', async () => {
    expect(await evalExpr(contentExpr, {}, { text: 'post this', imageLinks: [] })).toBe('post this');
    expect(await evalExpr(contentExpr, {}, { text: 'post this', imageLinks: ['https://a'] })).toEqual([{ type: 'input_text', text: 'post this' }, { type: 'input_image', image_url: 'https://a' }]);
    expect(await evalExpr(contentExpr, {}, { text: 'post this', imageLinks: ['https://a', 'https://b'] })).toHaveLength(3);
  });
  it('hides the Facebook tools from a tenant that lists them without the service on', async () => {
    const tenant = { assistant: { M: { tools: { L: [{ S: 'search_contacts' }, { S: 'draft_facebook_post' }, { S: 'cancel_facebook_draft' }] } } } };
    expect(await evalExpr(allowedToolsExpr, {}, { tenant, facebookOn: false })).toEqual(['search_contacts']);
    expect(await evalExpr(allowedToolsExpr, {}, { tenant, facebookOn: true })).toEqual(['search_contacts', 'draft_facebook_post', 'cancel_facebook_draft']);
    expect(await evalExpr(allowedToolsExpr, {}, { tenant: { assistant: { M: { tools: { L: [{ S: 'draft_facebook_post' }] } } } }, facebookOn: false })).toEqual([]);
  });
});
