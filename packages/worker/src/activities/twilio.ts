/** Twilio: our credentials from the platform secret, and a text to the person through the Messages API. */
import { env, secret } from './config.js';

export const TWILIO_API = 'https://api.twilio.com/2010-04-01/';

/** Our Twilio credentials, from the platform secret. */
export async function twilioCredentials(): Promise<{ accountSid: string; authToken: string }> {
  const s = await secret(env('TWILIO_SECRET_ARN'));
  if (!s.TWILIO_ACCOUNT_SID?.startsWith('AC') || !s.TWILIO_AUTH_TOKEN) throw new Error('the Twilio secret is not filled in');
  return { accountSid: s.TWILIO_ACCOUNT_SID, authToken: s.TWILIO_AUTH_TOKEN };
}

/** A text to the person: From is the tenant's number, To the person's. A body over Twilio's 1600 characters is rejected and fails the activity. */

export async function sendText(accountSid: string, from: string, to: string, body: string): Promise<void> {
  const c = await twilioCredentials();
  const res = await fetch(`${TWILIO_API}Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio refused the text: ${res.status} ${(await res.text()).slice(0, 300)}`);
}
