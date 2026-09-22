/** A text to the person, through Twilio's Messages API: From is the tenant's number, To the person's. A body over Twilio's 1600 characters is rejected and fails the activity. */
import { env, secret } from './config.js';

export const TWILIO_API = 'https://api.twilio.com/2010-04-01/';

export async function sendText(accountSid: string, from: string, to: string, body: string): Promise<void> {
  const s = await secret(env('TWILIO_SECRET_ARN'));
  if (!s.TWILIO_ACCOUNT_SID?.startsWith('AC') || !s.TWILIO_AUTH_TOKEN) throw new Error('the Twilio secret is not filled in');
  const res = await fetch(`${TWILIO_API}Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${s.TWILIO_ACCOUNT_SID}:${s.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio refused the text: ${res.status} ${(await res.text()).slice(0, 300)}`);
}
