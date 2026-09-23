import { describe, expect, it, vi } from 'vitest';
import { createResolver } from '../src/media-link.js';

const credentials = async () => ({ accountSid: 'AC' + 'a'.repeat(32), authToken: 'token' });
const req = { tenantPhone: '+15555550100', messageSid: 'MM' + 'b'.repeat(32), mediaSid: 'ME' + 'c'.repeat(32) };
const LINK = 'https://mms.twiliocdn.com/ACx/abc?Expires=1&Signature=s&Key-Pair-Id=k';

/** Twilio as the resolver meets it: the message JSON, then the media redirect. */
const twilio = (opts: { to?: string; mediaStatus?: number; location?: string | null } = {}) =>
  vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith('.json')
    ? new Response(JSON.stringify({ to: opts.to ?? req.tenantPhone }), { status: 200 })
    : new Response(null, { status: opts.mediaStatus ?? 307, headers: opts.location === null ? {} : { location: opts.location ?? LINK } }));

describe('media link resolver', () => {
  it('returns where Twilio redirects, without following it', async () => {
    const fetch = twilio();
    expect(await createResolver({ credentials, fetch })(req)).toEqual({ url: LINK });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages/${req.messageSid}/Media/${req.mediaSid}`);
    expect(init).toMatchObject({ redirect: 'manual' });
  });

  it('sends our credentials only to addresses it built under our own account', async () => {
    const fetch = twilio();
    await createResolver({ credentials, fetch })(req);
    for (const [url] of fetch.mock.calls) expect(String(url)).toMatch(new RegExp(`^https://api\\.twilio\\.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages/`));
  });

  it('refuses anything that is not a Twilio id, before asking Twilio', async () => {
    const fetch = twilio();
    const resolve = createResolver({ credentials, fetch });
    for (const bad of [
      { ...req, mediaSid: 'https://evil.example/x' },
      { ...req, messageSid: `${req.messageSid}/../../Accounts` },
      { ...req, mediaSid: 'ME123' },
      { ...req, tenantPhone: '' },
    ]) await expect(resolve(bad)).rejects.toThrow('required');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a photo that was texted to another tenant\'s number', async () => {
    const fetch = twilio({ to: '+15095550000' });
    await expect(createResolver({ credentials, fetch })(req)).rejects.toThrow('not sent to this tenant');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails when Twilio does not redirect to an https link', async () => {
    await expect(createResolver({ credentials, fetch: twilio({ mediaStatus: 404, location: null }) })(req)).rejects.toThrow('404');
    await expect(createResolver({ credentials, fetch: twilio({ location: 'http://plain.example/x' }) })(req)).rejects.toThrow('did not redirect');
  });
});
