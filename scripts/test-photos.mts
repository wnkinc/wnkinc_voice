/**
 * Proves the photo path against Twilio, the media bucket, and the model: the
 * newest texted photo is copied under its tenant, a presigned link fetches
 * with no credentials, and the vision call describes it. Runs the worker's
 * activities in this process with the operator's reads. Prints no numbers,
 * message text, or links.
 *
 *   npx tsx scripts/test-photos.mts      (text a photo to a tenant number first)
 */
import { execFileSync } from 'node:child_process';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { STACKS } from '../packages/infrastructure/names.js';

process.env.AWS_REGION ??= 'us-west-2';
const output = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--region', 'us-west-2',
  '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text'], { encoding: 'utf8' }).trim();
const secretArn = (prefix: string) => execFileSync('aws', ['secretsmanager', 'list-secrets', '--region', 'us-west-2',
  '--query', `SecretList[?starts_with(Name, '${prefix}')].ARN | [0]`, '--output', 'text'], { encoding: 'utf8' }).split('\n')[0]!.trim();
process.env.MEDIA_BUCKET ??= output(STACKS.platform, 'mediaBucketName');
process.env.TWILIO_SECRET_ARN ??= secretArn('TwilioSecret');
process.env.OPENAI_SECRET_ARN ??= secretArn('OpenAISecret');
process.env.ASSISTANT_MODEL ??= 'gpt-5.5';
const { presign, storePhotos } = await import('../packages/worker/src/activities/media.js');
const { describeImages } = await import('../packages/worker/src/activities/model.js');

const s = JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.TWILIO_SECRET_ARN }))).SecretString ?? '{}') as Record<string, string>;
const headers = { authorization: `Basic ${Buffer.from(`${s.TWILIO_ACCOUNT_SID}:${s.TWILIO_AUTH_TOKEN}`).toString('base64')}` };
const twilio = async (path: string) => (await fetch(`https://api.twilio.com${path}`, { headers })).json() as Promise<any>;
const inbound = (await twilio(`/2010-04-01/Accounts/${s.TWILIO_ACCOUNT_SID}/Messages.json?PageSize=20`)).messages
  .find((m: any) => m.direction === 'inbound' && Number(m.num_media) > 0);
if (!inbound) throw new Error('no inbound message with a photo among the last 20; text one first');
const media = (await twilio(inbound.subresource_uris.media)).media_list[0];
const tenantId = process.argv[2] ?? 'wnk';

const stored = await storePhotos(tenantId, inbound.to, [{ messageSid: inbound.sid, mediaSid: media.sid, contentType: media.content_type }]);
console.log(`stored       -> ${stored[0]!.key} (${stored[0]!.contentType})`);
const [url] = await presign([stored[0]!.key]);
const got = await fetch(url!);
console.log(`presigned    -> fetched with no credentials: ${got.status} ${got.headers.get('content-type')} ${(await got.arrayBuffer()).byteLength} bytes`);
if (!got.ok) process.exitCode = 1;
const d = await describeImages([url!]);
console.log(`described    -> "${d.descriptions[0]}" (${d.tokens} tokens)`);
await storePhotos(tenantId, '+15005550006', [{ messageSid: inbound.sid, mediaSid: media.sid, contentType: media.content_type }]).then(
  () => { console.log('wrong tenant -> STORED, which it must not'); process.exitCode = 1; },
  (e: Error) => console.log(`wrong tenant -> refused: ${e.message}`),
);
