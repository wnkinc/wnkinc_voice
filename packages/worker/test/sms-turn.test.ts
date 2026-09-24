/**
 * The SMS turn through a real Worker on Temporal's test server, every side
 * effect a recorded fake (test/fakes.ts). What these hold: the person's POST publishes once
 * and only on the revision they were shown, without the model; the model's
 * tools write drafts and nothing else, whatever the model asks for; the
 * draft the person sees is the row, under the model's line.
 */
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { smsTurn } from '../src/workflows/index.js';
import { answer, draft, fakes, person, photoRef, photoRow, run as runWorkflow, tenant, type Fakes, testEnv } from './fakes.js';

const text = (body: string, extra: Record<string, string> = {}) => ({ sms: { From: '+15550002222', To: '+15550001111', AccountSid: 'AC1', MessageSid: `MM${Math.random()}`, Body: body, NumMedia: '0', ...extra } });

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await testEnv(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const run = (f: Fakes, input: ReturnType<typeof text>) => runWorkflow(env, f, smsTurn, [input]);
const sent = (f: Fakes) => f.sendText.mock.calls.map((c) => c[3]);

describe('the approval', () => {
  it('POST on the shown revision locks the row, publishes once with the pinned release, and never runs the model', async () => {
    const f = fakes();
    f.findPending.mockResolvedValue(draft(2, 2));
    expect(await run(f, text('post'))).toBe('posted');
    expect(f.lockDraft).toHaveBeenCalledWith('deck', draft(2, 2).sk, 2, 'sms:+15550002222', 'post');
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    expect(f.presign).toHaveBeenCalledWith(['deck/MM1/ME1.jpg']);
    expect(f.executeTool).toHaveBeenCalledWith('deck', 'FACEBOOK_CREATE_PHOTO_POST', { page_id: '42', message: 'Cedar deck, finished today.', url: 'https://link/deck/MM1/ME1.jpg' }, '20260902_00');
    expect(f.markCompleted).toHaveBeenCalledWith('deck', draft(2, 2).sk, 'page_post1');
    expect(f.markPhotosPosted).toHaveBeenCalledWith('deck', [photoRef('1').sk], draft(2, 2).sk);
    expect(sent(f)).toEqual(['Posted to Deck Co: https://www.facebook.com/42/posts/post1']);
    expect(f.callModel).not.toHaveBeenCalled();
  }, 60_000);

  it('POST on a revision the person was not shown goes to the model, and nothing is published', async () => {
    const f = fakes();
    f.findPending.mockResolvedValue(draft(3, 2));
    expect(await run(f, text('POST'))).toBe('replied');
    expect(f.lockDraft).not.toHaveBeenCalled();
    expect(f.executeTool).not.toHaveBeenCalled();
    expect(f.callModel).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('a lock that fails (a second POST, or one that crossed a revision) publishes nothing', async () => {
    const f = fakes();
    f.findPending.mockResolvedValue(draft(2, 2));
    f.lockDraft.mockResolvedValue(false);
    expect(await run(f, text('POST'))).toBe('replied');
    expect(f.executeTool).not.toHaveBeenCalled();
  }, 60_000);

  it('a publish call that does not answer is tried once, leaves the row executing, and says so', async () => {
    const f = fakes();
    f.findPending.mockResolvedValue(draft(1, 1));
    f.executeTool.mockRejectedValue(new Error('timeout'));
    expect(await run(f, text('POST'))).toBe('post-unconfirmed');
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    expect(f.markUnconfirmed).toHaveBeenCalledTimes(1);
    expect(f.markFailed).not.toHaveBeenCalled();
    expect(sent(f)).toEqual(['I could not confirm whether that post went out. Check the Page before trying again.']);
  }, 60_000);

  it('a rejected post is marked failed and nothing was published', async () => {
    const f = fakes();
    f.findPending.mockResolvedValue(draft(1, 1));
    f.executeTool.mockResolvedValue({ successful: false, error: 'bad page' });
    expect(await run(f, text('POST'))).toBe('post-failed');
    expect(f.markFailed).toHaveBeenCalledWith('deck', draft(1, 1).sk, 'bad page');
  }, 60_000);
});

describe('the model', () => {
  it('drafts through the ledger naming photos by label, and the person sees the row under the model\'s line, recorded as shown', async () => {
    const f = fakes();
    f.listPhotos.mockResolvedValue([photoRow('1', { postedIn: 'old' }), photoRow('2'), photoRow('3')]);
    f.callModel
      .mockResolvedValueOnce(answer('', [{ call_id: 'c1', name: 'draft_facebook_post', arguments: JSON.stringify({ caption: 'Cedar deck, finished today.', photos: ['p2', 'p3'] }) }]))
      .mockResolvedValueOnce(answer('Drafted it.'));
    f.findPending.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...draft(1, 0), payload: { caption: 'Cedar deck, finished today.', media: [photoRef('2'), photoRef('3')] } });
    expect(await run(f, text('post the two from this afternoon'))).toBe('replied');
    expect(f.createDraft).toHaveBeenCalledWith('deck', 'sms:+15550002222', 'Cedar deck, finished today.', [photoRef('2'), photoRef('3')]);
    expect(f.callModel.mock.calls[0]?.[0].instructions).toContain('[p1] ');
    expect(f.callModel.mock.calls[0]?.[0].instructions).toContain('photo 1 (already posted');
    expect(f.callModel.mock.calls[0]?.[0].instructions).toContain('[p3] ');
    expect(f.executeTool).not.toHaveBeenCalled();
    expect(sent(f)).toHaveLength(1);
    expect(sent(f)[0]).toContain('Drafted it.\n\nDraft for the Facebook Page Deck Co:\n\nCedar deck, finished today.\n\nWith 2 photos: photo 2; photo 3.');
    expect(f.markShown).toHaveBeenCalledWith('deck', draft(1, 0).sk, 1);
    expect(f.recordUsage).toHaveBeenCalledWith('deck', 'sms:+15550002222', 6, 4, 2);
  }, 60_000);

  it('a label that is not on the list is refused, and no draft is written', async () => {
    const f = fakes();
    f.listPhotos.mockResolvedValue([photoRow('1')]);
    f.callModel
      .mockResolvedValueOnce(answer('', [{ call_id: 'c1', name: 'draft_facebook_post', arguments: JSON.stringify({ caption: 'Hi', photos: ['p4'] }) }]))
      .mockResolvedValueOnce(answer('Which photo?'));
    await run(f, text('post it'));
    expect(f.createDraft).not.toHaveBeenCalled();
    const outputs = f.callModel.mock.calls[1]?.[0].input as { output: string }[];
    expect(JSON.parse(outputs[0]!.output).error).toContain('no photo p4');
  }, 60_000);

  it('has no publish tool: a call to one is refused, and no Facebook call is made', async () => {
    const f = fakes();
    f.callModel
      .mockResolvedValueOnce(answer('', [{ call_id: 'c1', name: 'publish_facebook_post', arguments: '{}' }, { call_id: 'c2', name: 'add_note', arguments: '{}' }]))
      .mockResolvedValueOnce(answer('Done.'));
    expect(await run(f, text('publish it now'))).toBe('replied');
    expect(f.executeTool).not.toHaveBeenCalled();
    const outputs = f.callModel.mock.calls[1]?.[0].input as { call_id: string; output: string }[];
    expect(outputs.map((o) => o.output)).toEqual(['This tool is not available for this business.', 'This tool is not available for this business.']);
  }, 60_000);

  it('runs a CRM tool of Composio\'s as the tenant with the model\'s own arguments, and hands the model Composio\'s result', async () => {
    const f = fakes();
    f.callModel
      .mockResolvedValueOnce(answer('', [{ call_id: 'c1', name: 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', arguments: JSON.stringify({ query: 'Sarah', limit: 5 }) }]))
      .mockResolvedValueOnce(answer('Found Sarah.'));
    f.executeTool.mockResolvedValue({ successful: true, data: { total: 1, results: [{ id: '9', properties: { firstname: 'Sarah' } }] } });
    await run(f, text('who is Sarah?'));
    expect(f.executeTool).toHaveBeenCalledWith('deck', 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', { query: 'Sarah', limit: 5 }, '20260915_00');
    const outputs = f.callModel.mock.calls[1]?.[0].input as { output: string }[];
    expect(JSON.parse(outputs[0]!.output)).toEqual({ total: 1, results: [{ id: '9', properties: { firstname: 'Sarah' } }] });
    expect(f.callModel.mock.calls[0]?.[0].instructions).toContain('Added by My Assistant');
  }, 60_000);

  it('a tenant without the service sees no Facebook tools, and the reply goes out plain', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...tenant, facebookPosts: { enabled: false } });
    await run(f, text('hello'));
    expect(f.findPending).not.toHaveBeenCalled();
    expect((f.callModel.mock.calls[0]?.[0].tools as { name: string }[]).map((t) => t.name)).toEqual(['HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'HUBSPOT_CREATE_NOTE']);
    expect(sent(f)).toEqual(['Sure.']);
  }, 60_000);

  it('gives up after the round cap and after an empty answer', async () => {
    const f = fakes();
    f.callModel.mockResolvedValue(answer('', [{ call_id: 'c', name: 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', arguments: '{}' }]));
    await run(f, text('loop'));
    expect(f.callModel).toHaveBeenCalledTimes(7);
    expect(sent(f)).toEqual(['Sorry, I could not finish that. Try asking in a simpler way.']);
  }, 60_000);
});

describe('who may text', () => {
  it('a stranger, or a person texting another business\'s number, reaches nothing', async () => {
    const f = fakes();
    f.lookupPerson.mockResolvedValue(undefined);
    expect(await run(f, text('hi'))).toBe('unknown-sender');
    const g = fakes();
    g.lookupPerson.mockResolvedValue({ ...person, tenantPhone: '+15559999999' });
    expect(await run(g, text('hi'))).toBe('unknown-sender');
    expect(g.lookupTenant).not.toHaveBeenCalled();
    expect(sent(g)).toEqual([]);
  }, 60_000);

  it('a tenant with the assistant off answers nothing', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...tenant, assistant: { enabled: false } });
    expect(await run(f, text('hi'))).toBe('assistant-off');
    expect(f.callModel).not.toHaveBeenCalled();
  }, 60_000);

  it('a photo sent alone is a turn: stored under the tenant, a row written, described once, shown to the model; an empty text is not', async () => {
    const f = fakes();
    expect(await run(f, text('', { NumMedia: '1', MediaContentType0: 'image/jpeg', MediaUrl0: 'https://x/ME1' }))).toBe('replied');
    expect(f.storePhotos).toHaveBeenCalledWith('deck', '+15550001111', [{ messageSid: expect.any(String), mediaSid: 'ME1', contentType: 'image/jpeg' }]);
    const rows = f.putPhotos.mock.calls[0]![0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: 'deck', approver: 'sms:+15550002222', channel: 'sms', contentType: 'image/jpeg' });
    expect(rows[0]!.sk).toMatch(/^sms:\+15550002222#photo#\d{4}-.*#ME1$/);
    expect(f.describeImages).toHaveBeenCalledWith([`https://link/${rows[0]!.key}`]);
    expect(f.describePhotoRows).toHaveBeenCalledWith('deck', [rows[0]!.sk], ['thing 1']);
    const content = f.callModel.mock.calls[0]?.[0].input.at(-1) as { content: unknown[] };
    expect(content.content).toEqual([{ type: 'input_text', text: 'Sent 1 photos with no text.' }, { type: 'input_image', image_url: `https://link/${rows[0]!.key}` }]);
    // The vision call's tokens are metered with the turn's.
    expect(f.recordUsage).toHaveBeenCalledWith('deck', 'sms:+15550002222', 12, 10, 2);
    expect(await run(fakes(), text(' '))).toBe('ignored');
  }, 60_000);

  it('a photo the store refuses costs only the photo: the turn still answers, with no row and no image', async () => {
    const f = fakes();
    f.storePhotos.mockRejectedValue(new Error('that message was not sent to this tenant'));
    expect(await run(f, text('look', { NumMedia: '1', MediaContentType0: 'image/jpeg', MediaUrl0: 'https://x/ME1' }))).toBe('replied');
    expect(f.putPhotos).not.toHaveBeenCalled();
    expect(f.callModel.mock.calls[0]?.[0].input.at(-1)).toEqual({ role: 'user', content: 'look' });
  }, 60_000);
});
