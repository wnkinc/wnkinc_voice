/**
 * Twilio's inbound post, as the starter parses it and the workflow reads it.
 * Pure: shared by the starter Lambda, the workflow bundle, and the tests.
 */
import type { InboundPhoto } from '@wnk/shared/contracts';

/** Twilio's form fields (From, To, Body, AccountSid, MessageSid, NumMedia, MediaUrl<n>, ...). */
export type Sms = Record<string, string>;

/**
 * A form-encoded body (`a=1&b=x+y%21`) as an object. `+` is a space in form
 * encoding and decodeURIComponent does not know that, so it is replaced first;
 * a literal plus arrives as %2B and decodes correctly after.
 */
export function parseForm(body: string): Sms {
  const out: Sms = {};
  if (!body) return out;
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const key = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const value = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    out[key] = value;
  }
  return out;
}

/** The fields every text must carry to be routed at all. */
export function isRoutable(sms: Sms): boolean {
  return Boolean(sms.From && sms.To && sms.AccountSid && sms.MessageSid && sms.Body !== undefined);
}

/** The photos on an inbound post, images only; the media id is the last segment of the URL. */
export function mediaFromSms(sms: Sms): InboundPhoto[] {
  const n = sms.NumMedia ? Number(sms.NumMedia) : 0;
  const out: InboundPhoto[] = [];
  for (let i = 0; i < n; i++) {
    const contentType = sms[`MediaContentType${i}`] ?? '';
    const url = sms[`MediaUrl${i}`] ?? '';
    if (!contentType.startsWith('image/') || !sms.MessageSid) continue;
    const mediaSid = url.split('/').at(-1) ?? '';
    if (mediaSid) out.push({ messageSid: sms.MessageSid, mediaSid, contentType });
  }
  return out;
}

/** What the model and memory get as the person's text: the body, or a stand-in for a photo sent alone. */
export function textOrPhotos(sms: Sms): string {
  return (sms.Body ?? '').trim() !== '' ? sms.Body! : `Sent ${sms.NumMedia ?? '0'} photos with no text.`;
}
