/** The Facebook rules and the inbound parsing, as pure functions. */
import { describe, expect, it } from 'vitest';
import { APPROVAL_WORD, FACEBOOK_TOOLS, allowedTools, draftMessage, facebookOn, facebookPrompt, isApproval, modelContent, nextMedia, postId, postLink } from '../src/rules/facebook.js';
import { mediaFromSms, parseForm, textOrPhotos } from '../src/rules/sms.js';
import type { AssistantToolName, DraftRow } from '@wnk/shared/contracts';

const photo = (n: string) => ({ messageSid: 'MM1', mediaSid: `ME${n}` });
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
  it('reads the texted photos as a list of Twilio ids: none, one, several, images only', () => {
    expect(mediaFromSms(sms([]))).toEqual([]);
    expect(mediaFromSms({ Body: 'hi' })).toEqual([]);
    expect(mediaFromSms(sms([['image/jpeg', 'a']]))).toEqual([photo('a')]);
    expect(mediaFromSms(sms([['image/jpeg', 'a'], ['video/mp4', 'v'], ['image/png', 'b']]))).toEqual([photo('a'), photo('b')]);
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

describe('the draft', () => {
  it('applies the model\'s photos choice', () => {
    expect(nextMedia('use_new', [photo('old')], [photo('new')])).toEqual([photo('new')]);
    expect(nextMedia('add_new', [photo('old')], [photo('new')])).toEqual([photo('old'), photo('new')]);
    expect(nextMedia('keep', [photo('old')], [photo('new')])).toEqual([photo('old')]);
    expect(nextMedia('none', [photo('old')], [photo('new')])).toEqual([]);
  });
  it('a new draft has no photos to keep, and an empty message adds none', () => {
    expect(nextMedia('keep', [], [photo('new')])).toEqual([]);
    expect(nextMedia('add_new', [], [photo('new')])).toEqual([photo('new')]);
    expect(nextMedia('use_new', [], [])).toEqual([]);
    expect(nextMedia('add_new', [photo('a'), photo('b')], [])).toEqual([photo('a'), photo('b')]);
  });
  it('states the Page, the caption word for word, the photos, and the word that publishes', () => {
    const text = draftMessage('Deck Co', draft(1, 0, [photo('a'), photo('b')]));
    expect(text).toContain('Draft for the Facebook Page Deck Co:\n\nCedar deck, finished today.\n\n');
    expect(text).toContain('With the 2 photos you sent. Reply POST to publish it');
    expect(draftMessage('Deck Co', draft(1, 0, [photo('a')]))).toContain('With the 1 photo you sent.');
    expect(draftMessage('Deck Co', draft(1, 0, []))).toContain('No photos.');
  });
  it('tells the model where the photos came from, or that there are none', () => {
    expect(facebookPrompt(undefined, [photo('a')], false)).toContain('This message came with 1 photos.');
    expect(facebookPrompt(undefined, [photo('a'), photo('b')], true)).toContain('They sent 2 photos in a recent message');
    expect(facebookPrompt(undefined, [], false)).toContain('No photos are available for a draft.');
    expect(facebookPrompt(draft(1, 0), [], false)).toContain('There is a pending draft: Cedar deck, finished today. (1 photos)');
  });
  it('reads the post id from either tool shape', () => {
    expect(postId({ data: { id: 'photo1', post_id: 'page_post1' } })).toBe('page_post1');
    expect(postId({ data: { id: 'page_post2' } })).toBe('page_post2');
  });
  it('texts the /posts/ permalink shape the Facebook app opens, not the bare page_post id', () => {
    expect(postLink('42', '42_777')).toBe('https://www.facebook.com/42/posts/777');
    expect(postLink('42', '777')).toBe('https://www.facebook.com/42/posts/777');
  });
  it('gives the model the photos when their links were minted, the text alone otherwise', () => {
    expect(modelContent('post this', [])).toBe('post this');
    expect(modelContent('post this', ['https://a'])).toEqual([{ type: 'input_text', text: 'post this' }, { type: 'input_image', image_url: 'https://a' }]);
    expect(modelContent('post this', ['https://a', 'https://b'])).toHaveLength(3);
  });
});

describe('the tenant\'s allow-list', () => {
  const tools = ['search_contacts', 'draft_facebook_post', 'cancel_facebook_draft'] as const;
  it('hides the Facebook tools from a tenant that lists them without the service on', () => {
    expect(allowedTools(tools, false)).toEqual(['search_contacts']);
    expect(allowedTools(tools, true)).toEqual(tools);
    expect(allowedTools(['draft_facebook_post'], false)).toEqual([]);
  });
  it('the service is on only with the flag and the draft tool on the row', () => {
    const tenant = (enabled: boolean, t: AssistantToolName[]) => ({ tenantId: 't', phoneNumber: '+1', business: { name: 'x' }, assistant: { enabled: true, tools: t }, facebookPosts: { enabled, pageId: '1', pageName: 'P' } });
    expect(facebookOn(tenant(true, [...tools]))).toBe(true);
    expect(facebookOn(tenant(false, [...tools]))).toBe(false);
    expect(facebookOn(tenant(true, ['search_contacts']))).toBe(false);
  });
});
