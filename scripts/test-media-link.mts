/**
 * Proves the media link resolver against Twilio: the newest texted photo
 * resolves to a link that fetches with no credentials, and the same photo
 * named under another tenant's number is refused. Runs the handler in this
 * process with the operator's read of the Twilio secret. Prints no numbers,
 * message text, or links.
 *
 *   npx tsx scripts/test-media-link.mts      (text a photo to a tenant number first)
 */
import { execFileSync } from 'node:child_process';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

process.env.AWS_REGION ??= 'us-west-2';
process.env.TWILIO_SECRET_ARN ??= execFileSync('aws', ['secretsmanager', 'list-secrets', '--region', 'us-west-2',
  '--query', "SecretList[?starts_with(Name, 'TwilioSecret')].ARN | [0]", '--output', 'text'], { encoding: 'utf8' }).split('\n')[0]!.trim();
const { handler } = await import('../packages/media-link/src/media-link.js');

const s = JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.TWILIO_SECRET_ARN }))).SecretString ?? '{}') as Record<string, string>;
const headers = { authorization: `Basic ${Buffer.from(`${s.TWILIO_ACCOUNT_SID}:${s.TWILIO_AUTH_TOKEN}`).toString('base64')}` };
const twilio = async (path: string) => (await fetch(`https://api.twilio.com${path}`, { headers })).json() as Promise<any>;

const inbound = (await twilio(`/2010-04-01/Accounts/${s.TWILIO_ACCOUNT_SID}/Messages.json?PageSize=20`)).messages
  .find((m: any) => m.direction === 'inbound' && Number(m.num_media) > 0);
if (!inbound) throw new Error('no inbound message with a photo among the last 20; text one first');
const media = (await twilio(inbound.subresource_uris.media)).media_list[0];

const { url } = await handler({ tenantPhone: inbound.to, messageSid: inbound.sid, mediaSid: media.sid });
const got = await fetch(url);
console.log(`photo        -> ${new URL(url).host}; fetched with no credentials: ${got.status} ${got.headers.get('content-type')} ${(await got.arrayBuffer()).byteLength} bytes`);
if (!got.ok) process.exitCode = 1;

await handler({ tenantPhone: '+15005550006', messageSid: inbound.sid, mediaSid: media.sid }).then(
  () => { console.log('wrong tenant -> RESOLVED, which it must not'); process.exitCode = 1; },
  (e: Error) => console.log(`wrong tenant -> refused: ${e.message}`),
);
