/**
 * Point a tenant's Twilio number at the platform for SMS (or show what it has).
 *
 *   npx tsx scripts/twilio-webhook.mts set <tenantId>    # SmsUrl = <apiEndpoint>/sms/<WEBHOOK_PATH>, POST
 *   npx tsx scripts/twilio-webhook.mts info <tenantId>   # what the number has now
 *
 * Reads the account SID, auth token and the generated path from the Twilio
 * secret, the API endpoint from the voice stack, and the number from
 * tenants/<tenantId>.json, so the secret path never passes through a
 * terminal or a file. Set the credentials first (and write them to the
 * Connection too; see README):
 *   aws secretsmanager put-secret-value --secret-id <twilioSecretArn> \
 *     --secret-string "$(aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text \
 *       | jq -c '.TWILIO_ACCOUNT_SID = "AC..." | .TWILIO_AUTH_TOKEN = "..."')"
 *
 * Configures the number itself. A number that sends through a Messaging
 * Service takes its inbound webhook from the service instead; set it there.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const action = process.argv[2] ?? 'info';
const tenantId = process.argv[3];
if (!tenantId) { console.error('usage: npx tsx scripts/twilio-webhook.mts set|info <tenantId>'); process.exit(2); }
const output = (stack: string, key: string) =>
  execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', 'us-west-2'], { encoding: 'utf8' }).trim();

const { phoneNumber } = JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')) as { phoneNumber: string };
const secretArn = output('wnk-runtime-dev', 'twilioSecretArn');
const apiEndpoint = output('wnk-voice-dev', 'apiEndpoint');
const sm = new SecretsManagerClient({ region: 'us-west-2' });
const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString ?? '{}') as { TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; WEBHOOK_PATH?: string };
if (!secret.TWILIO_ACCOUNT_SID || secret.TWILIO_ACCOUNT_SID === 'set-me') throw new Error(`TWILIO_ACCOUNT_SID not set in ${secretArn}`);
if (!secret.TWILIO_AUTH_TOKEN || secret.TWILIO_AUTH_TOKEN === 'set-me') throw new Error(`TWILIO_AUTH_TOKEN not set in ${secretArn}`);
if (!secret.WEBHOOK_PATH) throw new Error('WEBHOOK_PATH missing from the Twilio secret');

const base = `https://api.twilio.com/2010-04-01/Accounts/${secret.TWILIO_ACCOUNT_SID}`;
const auth = `Basic ${Buffer.from(`${secret.TWILIO_ACCOUNT_SID}:${secret.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
const api = async (path: string, form?: Record<string, string>) => {
  const res = await fetch(`${base}${path}`, {
    method: form ? 'POST' : 'GET',
    headers: { authorization: auth, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

const list = await api(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`) as { incoming_phone_numbers: { sid: string; phone_number: string; sms_url: string; sms_method: string; capabilities: { sms: boolean } }[] };
const number = list.incoming_phone_numbers[0];
if (!number) throw new Error(`no incoming phone number ${phoneNumber} in account ${secret.TWILIO_ACCOUNT_SID}`);
if (!number.capabilities.sms) throw new Error(`${phoneNumber} is not SMS-capable`);

if (action === 'set') {
  const url = `${apiEndpoint}/sms/${secret.WEBHOOK_PATH}`;
  const updated = await api(`/IncomingPhoneNumbers/${number.sid}.json`, { SmsUrl: url, SmsMethod: 'POST' }) as { sms_url: string; sms_method: string };
  console.log({ phoneNumber, sid: number.sid, smsMethod: updated.sms_method, smsUrl: updated.sms_url.replace(secret.WEBHOOK_PATH, '<WEBHOOK_PATH>') });
} else {
  console.log({ phoneNumber, sid: number.sid, smsMethod: number.sms_method, smsUrl: number.sms_url ? number.sms_url.replace(secret.WEBHOOK_PATH, '<WEBHOOK_PATH>') : '(none)' });
}
