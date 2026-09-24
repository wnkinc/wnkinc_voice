/** The Facebook rules and the inbound parsing, as pure functions. */
import { describe, expect, it } from 'vitest';
import { APPROVAL_WORD, FACEBOOK_TOOLS, allowedTools, draftMessage, facebookOn, facebookPrompt, isApproval, modelContent, photoList, photoRow, postId, postLink, resolvePhotos, whenText } from '../src/rules/facebook.js';
import { mediaFromSms, parseForm, textOrPhotos } from '../src/rules/sms.js';
import type { AssistantToolName, DraftRow, PhotoRow } from '@wnk/shared/contracts';

const inbound = (n: string, contentType = 'image/jpeg') => ({ messageSid: 'MM1', mediaSid: `ME${n}`, contentType });
const row = (n: string, extra: Partial<PhotoRow> = {}): PhotoRow =>
  ({ tenantId: 't', sk: `sms:+1#photo#2026-09-22T16:0${n}:00.000Z#ME${n}`, approver: 'sms:+1', channel: 'sms', key: `t/MM1/ME${n}.jpg`, contentType: 'image/jpeg', receivedAt: `2026-09-22T16:0${n}:00.000Z`, description: `thing ${n}`, expiresAt: 9e9, ...extra });
const photo = (n: string) => ({ sk: row(n).sk, key: row(n).key, description: `thing ${n}` });
const NOW = '2026-09-22T20:00:00.000Z';
const TZ = 'America/Los_Angeles';
const sms = (media: [string, string][], body = 'post this') => ({
  Body: body, MessageSid: 'MM1', NumMedia: String(media.length),
  ...Object.fromEntries(media.flatMap(([type, id], i) => [[`MediaContentType${i}`, type], [`MediaUrl${i}`, `https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME${id}`]])),
});
const draft = (revision: number, shown: number, media = [photo('a')], caption = 'Cedar deck, finished today.'): DraftRow =>
  ({ tenantId: 't', sk: 'sms:+1#facebook_post#t#1', status: 'pending', revision, shownRevision: shown, approveBy: 9e9, payload: { caption, media } });

describe('inbound text', () => {
  it('decodes a Twilio post: %2B stays a plus, + becomes a space, %xx decodes', () => {
    expect(parseForm('From=%2B15551234567&Body=hi+there%21&NumMedia=0')).toEqual({ From: '+15551234567', Body: 'hi there!', NumMedia: '0' });
    expect(parseForm('a=&b')).toEqual({ a: '', b: '' });
    expect(parseForm('')).toEqual({});
  });
  it('reads the texted photos as Twilio ids with their type: none, one, several, images only', () => {
    expect(mediaFromSms(sms([]))).toEqual([]);
    expect(mediaFromSms({ Body: 'hi' })).toEqual([]);
    expect(mediaFromSms(sms([['image/jpeg', 'a']]))).toEqual([inbound('a')]);
    expect(mediaFromSms(sms([['image/jpeg', 'a'], ['video/mp4', 'v'], ['image/png', 'b']]))).toEqual([inbound('a'), inbound('b', 'image/png')]);
    expect(mediaFromSms(sms([['video/mp4', 'v']]))).toEqual([]);
  });
  it('a photo sent alone still has text for the model', () => {
    expect(textOrPhotos(sms([['image/jpeg', 'a']], ' '))).toBe('Sent 1 photos with no text.');
    expect(textOrPhotos(sms([['image/jpeg', 'a']], 'post this'))).toBe('post this');
  });
});

describe('the approval', () => {
  it('only the whole word approves, in any case, with stray spaces', () => {
    for (const text of ['POST', 'post', ' Post \n']) expect(isApproval(text, draft(2, 2))).toBe(true);
    for (const text of ['post it', 'yes', 'YES POST', 'POST.', 'go ahead and post', '']) expect(isApproval(text, draft(2, 2))).toBe(false);
  });
  it('approves nothing without a draft, or on a revision the person has not been shown', () => {
    expect(isApproval('POST', undefined)).toBe(false);
    expect(isApproval('POST', draft(3, 2))).toBe(false);
    expect(isApproval('POST', draft(1, 0))).toBe(false);
  });
});

describe('photos as named things', () => {
  const photos = [row('1', { postedIn: 'sms:+1#facebook_post#x', postedAt: '2026-09-22T16:05:00.000Z' }), row('2'), row('3', { description: undefined })];

  it('a texted photo becomes a row under the tenant and the person, keyed by when it arrived and which media it was', () => {
    const r = photoRow('t', 'sms:+1', { ...inbound('9'), key: 't/MM1/ME9.jpg' }, '2026-09-22T16:09:00.000Z', 1_000);
    expect(r).toEqual({ tenantId: 't', sk: 'sms:+1#photo#2026-09-22T16:09:00.000Z#ME9', approver: 'sms:+1', channel: 'sms', key: 't/MM1/ME9.jpg', contentType: 'image/jpeg', receivedAt: '2026-09-22T16:09:00.000Z', expiresAt: 1_000 + 30 * 86400 });
  });
  it('says when a photo arrived as the person would: today with the time, otherwise the day too, in the business timezone', () => {
    expect(whenText('2026-09-22T16:02:00.000Z', TZ, NOW)).toBe('today 9:02 AM');
    expect(whenText('2026-09-21T23:30:00.000Z', TZ, NOW)).toBe('Mon, Sep 21 4:30 PM');
  });
  it('lists the photos for the model, labeled oldest first, with what each shows and whether it went out', () => {
    const text = photoList(photos, TZ, NOW);
    expect(text).toContain('[p1] today 9:01 AM: thing 1 (already posted today 9:05 AM)');
    expect(text).toContain('[p2] today 9:02 AM: thing 2');
    expect(text).toContain('[p3] today 9:03 AM: photo');
    expect(text).toContain('the newest ones');
    expect(photoList([], TZ, NOW)).toContain('no photos recently');
  });
  it('resolves the model\'s labels to the draft\'s photos, in the order named, once each', () => {
    expect(resolvePhotos(['p3', 'p2'], photos)).toEqual({ refs: [{ ...photo('3'), description: 'photo' }, photo('2')] });
    expect(resolvePhotos(['P2', 'p2 '], photos)).toEqual({ refs: [photo('2')] });
    expect(resolvePhotos([], photos)).toEqual({ refs: [] });
  });
  it('refuses a label that is not on the list, a non-list, and more than a post carries, naming what is available', () => {
    expect(resolvePhotos(['p4'], photos)).toEqual({ error: 'There is no photo p4. The photos available are p1, p2, p3.' });
    expect(resolvePhotos(['p1'], [])).toMatchObject({ error: expect.stringContaining('none') });
    expect(resolvePhotos('p1', photos)).toMatchObject({ error: expect.stringContaining('list of labels') });
    expect(resolvePhotos(Array.from({ length: 11 }, (_, i) => `p${i + 1}`), Array.from({ length: 11 }, (_, i) => row(String(i))))).toMatchObject({ error: expect.stringContaining('at most 10') });
  });
  it('tells the model about the pending draft\'s photos by what they show', () => {
    expect(facebookPrompt(draft(1, 0, [photo('a'), photo('b')]), photos, TZ, NOW)).toContain('(photos: thing a; thing b)');
    expect(facebookPrompt(undefined, [], TZ, NOW)).not.toContain('pending draft');
  });
});

describe('the draft', () => {
  it('states the Page, the caption word for word, the photos, and the word that publishes', () => {
    const text = draftMessage('Deck Co', draft(1, 0, [photo('a'), photo('b')]));
    expect(text).toContain('Draft for the Facebook Page Deck Co:\n\nCedar deck, finished today.\n\n');
    expect(text).toContain('With 2 photos: thing a; thing b. Reply POST to publish it');
    expect(draftMessage('Deck Co', draft(1, 0, [photo('a')]))).toContain('With 1 photo: thing a.');
    expect(draftMessage('Deck Co', draft(1, 0, []))).toContain('No photos.');
  });
  it('tells the model about the pending draft, and what it may name', () => {
    expect(facebookPrompt(draft(1, 0), [], TZ, NOW)).toContain('There is a pending draft: Cedar deck, finished today. (photos: thing a)');
    expect(facebookPrompt(undefined, [row('1')], TZ, NOW)).toContain('[p1] today 9:01 AM: thing 1');
  });
  it('reads the post id from either tool shape', () => {
    expect(postId({ data: { id: 'photo1', post_id: 'page_post1' } })).toBe('page_post1');
    expect(postId({ data: { id: 'page_post2' } })).toBe('page_post2');
  });
  it('texts the /posts/ permalink shape the Facebook app opens, not the bare page_post id', () => {
    expect(postLink('42', '42_777')).toBe('https://www.facebook.com/42/posts/777');
    expect(postLink('42', '777')).toBe('https://www.facebook.com/42/posts/777');
  });
  it('gives the model the photos when their links were presigned, the text alone otherwise', () => {
    expect(modelContent('post this', [])).toBe('post this');
    expect(modelContent('post this', ['https://a'])).toEqual([{ type: 'input_text', text: 'post this' }, { type: 'input_image', image_url: 'https://a' }]);
    expect(modelContent('post this', ['https://a', 'https://b'])).toHaveLength(3);
  });
});

describe('the tenant\'s allow-list', () => {
  const tools = ['draft_facebook_post', 'cancel_facebook_draft'] as const;
  it('hides the Facebook tools from a tenant that lists them without the service on', () => {
    expect(allowedTools(tools, false)).toEqual([]);
    expect(allowedTools(tools, true)).toEqual(tools);
    expect(allowedTools(['draft_facebook_post'], false)).toEqual([]);
  });
  it('the service is on only with the flag and the draft tool on the row', () => {
    const tenant = (enabled: boolean, t: AssistantToolName[]) => ({ tenantId: 't', phoneNumber: '+1', business: { name: 'x' }, assistant: { enabled: true, tools: t }, facebookPosts: { enabled, pageId: '1', pageName: 'P' } });
    expect(facebookOn(tenant(true, [...tools]))).toBe(true);
    expect(facebookOn(tenant(false, [...tools]))).toBe(false);
    expect(facebookOn(tenant(true, []))).toBe(false);
  });
});
