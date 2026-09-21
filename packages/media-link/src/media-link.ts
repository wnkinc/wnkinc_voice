/**
 * The media link resolver: a texted photo as a link someone else can fetch.
 * Twilio serves MMS media only to our credentials (media auth stays on for
 * every tenant), and answers an authenticated request with a redirect to a
 * signed link that works for anyone for about four hours. A workflow cannot
 * read that redirect: Step Functions fails an HTTP task on a 307 and hands
 * the workflow only the error name, not the Location header. So this is
 * code, and nothing else is: it asks Twilio, does not follow the redirect,
 * and returns where it points. No bytes move and nothing is stored; a
 * workflow calls it again whenever it needs a fresh link (when the model
 * looks at the photo, and again when Facebook fetches it).
 *
 * It takes ids, never a URL: the Twilio address is built here, under our own
 * account, so our credentials can only ever go to Twilio. The message must
 * have been sent to the tenant's number the workflow names, so one tenant's
 * workflow cannot mint a link to another tenant's photo.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface MediaLinkRequest {
  /** The tenant's number (E.164), the one the photo was texted to. */
  tenantPhone: string;
  /** Twilio's MessageSid from the inbound post. */
  messageSid: string;
  /** The last segment of the inbound post's MediaUrl<n>. */
  mediaSid: string;
}

export interface MediaLinkDeps {
  credentials: () => Promise<{ accountSid: string; authToken: string }>;
  fetch?: typeof fetch;
}

const TWILIO = 'https://api.twilio.com/2010-04-01';
const MESSAGE_SID = /^(MM|SM)[0-9a-f]{32}$/;
const MEDIA_SID = /^ME[0-9a-f]{32}$/;

export function createResolver(deps: MediaLinkDeps) {
  const call = deps.fetch ?? fetch;
  return async (req: MediaLinkRequest): Promise<{ url: string }> => {
    if (!req?.tenantPhone || !MESSAGE_SID.test(req.messageSid ?? '') || !MEDIA_SID.test(req.mediaSid ?? '')) throw new Error('tenantPhone, messageSid and mediaSid are required');
    const { accountSid, authToken } = await deps.credentials();
    const headers = { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` };
    const message = `${TWILIO}/Accounts/${accountSid}/Messages/${req.messageSid}`;

    const sent = await call(`${message}.json`, { headers });
    if (!sent.ok) throw new Error(`Twilio message lookup failed: ${sent.status}`);
    if (((await sent.json()) as { to?: string }).to !== req.tenantPhone) throw new Error('that message was not sent to this tenant');

    const media = await call(`${message}/Media/${req.mediaSid}`, { headers, redirect: 'manual' });
    const url = media.headers.get('location');
    if (media.status < 300 || media.status > 399 || !url?.startsWith('https://')) throw new Error(`Twilio did not redirect to a media link: ${media.status}`);
    return { url };
  };
}

// ---- Production wiring ------------------------------------------------------

let credentials: Promise<{ accountSid: string; authToken: string }> | undefined;
export const handler = createResolver({
  credentials: () => (credentials ??= (async () => {
    const arn = process.env.TWILIO_SECRET_ARN;
    if (!arn) throw new Error('TWILIO_SECRET_ARN not set');
    const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    const s = JSON.parse(res.SecretString ?? '{}') as { TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string };
    if (!s.TWILIO_ACCOUNT_SID?.startsWith('AC') || !s.TWILIO_AUTH_TOKEN) throw new Error('the Twilio secret is not filled in');
    return { accountSid: s.TWILIO_ACCOUNT_SID, authToken: s.TWILIO_AUTH_TOKEN };
  })()),
});
