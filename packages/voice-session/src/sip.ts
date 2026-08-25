import { normalizePhone, type CallParty } from '@wnk/shared';

export { normalizePhone };

export interface SipHeader {
  name: string;
  value: string;
}

/**
 * Headers (in priority order) that may carry the *called* number depending on the carrier.
 * Verified 2026-08-21 with Twilio Elastic SIP Trunking -> OpenAI: `To` holds the OpenAI
 * project id (sip:proj_...@sip.api.openai.com) and the dialed number arrives in
 * `Diversion: <sip:+1...@twilio.com>;reason=unconditional`. `To` is kept first for
 * carriers that preserve it.
 */
const CALLED_HEADERS = ['To', 'Diversion', 'X-Called-Number', 'P-Called-Party-ID', 'X-Twilio-To'];
const CALLER_HEADERS = ['From', 'P-Asserted-Identity', 'X-Twilio-From'];

export function getHeader(headers: SipHeader[], name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === n)?.value;
}

/**
 * Pull an E.164 number out of a SIP URI / header value such as
 *   "sip:+15555550100@sip.example.com", "<sip:15555550100@host>;tag=abc", "tel:+1555..."
 * Returns undefined if the user part isn't a phone number (e.g. a proj_ id).
 */
export function extractE164(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /(?:sips?|tel):\+?([0-9][0-9().\-\s]*)(?=[@;>\s]|$)/i.exec(value);
  let raw: string;
  if (m?.[1]) raw = m[1];
  else if (/^\s*\+?[\d().\-\s]+\s*$/.test(value)) raw = value;
  else return undefined;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return undefined;
  return `+${digits}`;
}

/** Identify caller and callee from the SIP headers OpenAI forwards in the webhook. */
export function identifyParties(headers: SipHeader[]): CallParty {
  const to = CALLED_HEADERS.map((h) => extractE164(getHeader(headers, h))).find(Boolean);
  const from = CALLER_HEADERS.map((h) => extractE164(getHeader(headers, h))).find(Boolean);
  return { from, to };
}

