/**
 * A texted photo, kept where the platform can hand it out: copied once from
 * Twilio into the media bucket under the tenant, and handed to the model or to
 * Facebook as a presigned link that lasts an hour. Twilio serves MMS media only
 * to our credentials (media auth stays on for every tenant), so the copy is the
 * one place those credentials are used for a photo, and the key is built here
 * from Twilio's ids: the fetch can only ever go to Twilio, under our account,
 * and the same photo stored twice lands on the same key.
 *
 * The message must have been sent to the tenant's number the workflow names,
 * so one tenant's turn cannot store another tenant's photo under itself.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { InboundPhoto } from '@wnk/shared/contracts';
import { env } from './config.js';
import { TWILIO_API, twilioCredentials } from './twilio.js';

const MESSAGE_SID = /^(MM|SM)[0-9a-f]{32}$/;
const MEDIA_SID = /^ME[0-9a-f]{32}$/;
const TENANT_ID = /^[a-z0-9-]{1,40}$/;
/** How long a handed-out link works: long enough for the model to read it, or Facebook to fetch it, in this turn. */
export const LINK_SECONDS = 3600;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' };

export interface StoredPhoto { messageSid: string; mediaSid: string; key: string; contentType: string }

export interface StoreDeps {
  credentials: () => Promise<{ accountSid: string; authToken: string }>;
  put: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  fetch?: typeof fetch;
}

/** The object key for a texted photo: the tenant, then Twilio's ids, so a retry writes the same object. */
export function photoKey(tenantId: string, p: InboundPhoto): string {
  return `${tenantId}/${p.messageSid}/${p.mediaSid}.${EXT[p.contentType] ?? 'bin'}`;
}

/** The store over its dependencies, so a test can meet it with a fake Twilio and a fake bucket. */
export function createStore(deps: StoreDeps) {
  const call = deps.fetch ?? fetch;
  return async (tenantId: string, tenantPhone: string, photos: InboundPhoto[]): Promise<StoredPhoto[]> => {
    if (!TENANT_ID.test(tenantId) || !tenantPhone) throw new Error('tenantId and tenantPhone are required');
    for (const p of photos) {
      if (!MESSAGE_SID.test(p.messageSid ?? '') || !MEDIA_SID.test(p.mediaSid ?? '')) throw new Error('messageSid and mediaSid must be Twilio ids');
    }
    if (photos.length === 0) return [];
    const { accountSid, authToken } = await deps.credentials();
    const headers = { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` };
    const out: StoredPhoto[] = [];
    const checked = new Set<string>();
    for (const p of photos) {
      const message = `${TWILIO_API}Accounts/${accountSid}/Messages/${p.messageSid}`;
      if (!checked.has(p.messageSid)) {
        const sent = await call(`${message}.json`, { headers });
        if (!sent.ok) throw new Error(`Twilio message lookup failed: ${sent.status}`);
        if (((await sent.json()) as { to?: string }).to !== tenantPhone) throw new Error('that message was not sent to this tenant');
        checked.add(p.messageSid);
      }
      // Twilio answers the media address with a redirect to its CDN; following it is the one fetch that leaves Twilio, and it carries no credentials.
      const res = await call(`${message}/Media/${p.mediaSid}`, { headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`Twilio media fetch failed: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) throw new Error(`photo is ${bytes.byteLength} bytes`);
      const contentType = res.headers.get('content-type')?.split(';')[0] || p.contentType;
      const key = photoKey(tenantId, { ...p, contentType });
      await deps.put(key, bytes, contentType);
      out.push({ messageSid: p.messageSid, mediaSid: p.mediaSid, key, contentType });
    }
    return out;
  };
}

const s3 = new S3Client({});
const bucket = () => env('MEDIA_BUCKET');

const store = createStore({
  credentials: twilioCredentials,
  put: async (key, body, contentType) => { await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType })); },
});

/** This text's photos, copied into the media bucket under the tenant. Idempotent: the same photo lands on the same key. */
export function storePhotos(tenantId: string, tenantPhone: string, photos: InboundPhoto[]): Promise<StoredPhoto[]> {
  return store(tenantId, tenantPhone, photos);
}

/** Links to stored photos that anyone can fetch for an hour: for the model to look at, or for Facebook to pull. */
export async function presign(keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const key of keys) out.push(await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: LINK_SECONDS }));
  return out;
}
