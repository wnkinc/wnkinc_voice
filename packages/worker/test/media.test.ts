/** The photo store: our credentials only to Twilio, one tenant's photo never stored under another, the bytes on a key built from the ids. */
import { describe, expect, it, vi } from 'vitest';
import { MAX_PHOTO_BYTES, createStore, photoKey } from '../src/activities/media.js';

const credentials = async () => ({ accountSid: 'AC' + 'a'.repeat(32), authToken: 'token' });
const TENANT = '+15555550100';
const p = (n: string, contentType = 'image/jpeg') => ({ messageSid: 'MM' + 'b'.repeat(32), mediaSid: `ME${n.repeat(32)}`, contentType });

/** Twilio as the store meets it: the message JSON, then the media bytes (the redirect already followed by fetch). */
const twilio = (opts: { to?: string; status?: number; bytes?: number; type?: string } = {}) =>
  vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith('.json')
    ? new Response(JSON.stringify({ to: opts.to ?? TENANT }), { status: 200 })
    : new Response(new Uint8Array(opts.bytes ?? 3), { status: opts.status ?? 200, headers: { 'content-type': opts.type ?? 'image/jpeg' } }));
const bucket = () => vi.fn(async (_key: string, _body: Uint8Array, _type: string) => undefined);

describe('the photo store', () => {
  it('fetches each photo from Twilio following the redirect, and puts it under the tenant on a key from the ids', async () => {
    const fetch = twilio(); const put = bucket();
    const stored = await createStore({ credentials, fetch, put })('deck', TENANT, [p('c'), p('d', 'image/png')]);
    expect(stored.map((s) => s.key)).toEqual([`deck/${p('c').messageSid}/${p('c').mediaSid}.jpg`, `deck/${p('d').messageSid}/${p('d').mediaSid}.jpg`]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]![2]).toBe('image/jpeg');
    const media = fetch.mock.calls.filter(([u]) => !String(u).endsWith('.json'));
    expect(media).toHaveLength(2);
    expect(media[0]![1]).toMatchObject({ redirect: 'follow' });
  });

  it('the type Twilio serves wins over the type the webhook said, and the key follows it', () => {
    expect(photoKey('deck', p('c', 'image/png'))).toMatch(/\.png$/);
    expect(photoKey('deck', p('c', 'image/heic'))).toMatch(/\.heic$/);
    expect(photoKey('deck', p('c', 'application/octet-stream'))).toMatch(/\.bin$/);
  });

  it('sends our credentials only to addresses it built under our own account, and checks each message once', async () => {
    const fetch = twilio();
    await createStore({ credentials, fetch, put: bucket() })('deck', TENANT, [p('c'), p('d')]);
    for (const [url] of fetch.mock.calls) expect(String(url)).toMatch(new RegExp(`^https://api\\.twilio\\.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages/`));
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('.json'))).toHaveLength(1);
  });

  it('refuses anything that is not a Twilio id, or a tenant id that is not one, before asking Twilio or writing', async () => {
    const fetch = twilio(); const put = bucket();
    const store = createStore({ credentials, fetch, put });
    for (const [tenant, photos] of [
      ['deck', [{ ...p('c'), mediaSid: 'https://evil.example/x' }]],
      ['deck', [{ ...p('c'), messageSid: `${p('c').messageSid}/../../Accounts` }]],
      ['../other', [p('c')]],
      ['', [p('c')]],
    ] as const) await expect(store(tenant, TENANT, [...photos])).rejects.toThrow(/required|Twilio ids/);
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a photo that was texted to another tenant\'s number, before fetching or writing it', async () => {
    const fetch = twilio({ to: '+15095550000' }); const put = bucket();
    await expect(createStore({ credentials, fetch, put })('deck', TENANT, [p('c')])).rejects.toThrow('not sent to this tenant');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it('fails on a missing photo, an empty one, or one too large, and writes nothing', async () => {
    const put = bucket();
    await expect(createStore({ credentials, fetch: twilio({ status: 404 }), put })('deck', TENANT, [p('c')])).rejects.toThrow('404');
    await expect(createStore({ credentials, fetch: twilio({ bytes: 0 }), put })('deck', TENANT, [p('c')])).rejects.toThrow('0 bytes');
    await expect(createStore({ credentials, fetch: twilio({ bytes: MAX_PHOTO_BYTES + 1 }), put })('deck', TENANT, [p('c')])).rejects.toThrow('bytes');
    expect(put).not.toHaveBeenCalled();
  });

  it('nothing to store is nothing done', async () => {
    const fetch = twilio();
    expect(await createStore({ credentials, fetch, put: bucket() })('deck', TENANT, [])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
