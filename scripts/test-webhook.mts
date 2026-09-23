/**
 * Post a signed, synthetic OpenAI webhook at the platform and watch what the
 * verifier and the accept workflow do with it. No real call exists, so an
 * incoming-call event ends at OpenAI's accept with a 404: the path up to and
 * including the claim is proven, and the call row ends `failed` (the accept
 * workflow's failed-executions alarm fires once; expected).
 *
 *   npx tsx scripts/test-webhook.mts ping                 # a non-call event: verifier 200, workflow Ignored
 *   npx tsx scripts/test-webhook.mts call [to] [from]     # Twilio-shaped SIP headers for a tenant's number
 *   npx tsx scripts/test-webhook.mts bad                  # wrong signature: 400
 */
import { createHmac, randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { execFileSync } from 'node:child_process';
import { STACKS } from '../packages/infrastructure/names.js';

const REGION = 'us-west-2';
const mode = process.argv[2] ?? 'ping';
const to = process.argv[3] ?? '+15555550100';
const from = process.argv[4] ?? '+15555550155';
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();
const url = out(STACKS.receptionist, 'webhookUrl');
const secretArn = out(STACKS.platform, 'openaiSecretArn');
const callsTable = out(STACKS.platform, 'callsTableName');
const sm = new SecretsManagerClient({ region: REGION });
const secret = (JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString ?? '{}') as { OPENAI_WEBHOOK_SECRET: string }).OPENAI_WEBHOOK_SECRET;

const callId = `rtc_test_${randomBytes(6).toString('hex')}`;
const body = JSON.stringify(mode === 'ping'
  ? { object: 'event', id: `evt_${callId}`, type: 'ping.test', created_at: Math.floor(Date.now() / 1000), data: {} }
  : { object: 'event', id: `evt_${callId}`, type: 'realtime.call.incoming', created_at: Math.floor(Date.now() / 1000), data: {
      call_id: callId,
      sip_headers: [
        { name: 'From', value: `<sip:${from}@pstn.twilio.com>;tag=abc` },
        { name: 'To', value: '<sip:proj_TEST@sip.api.openai.com;transport=tls>' },
        { name: 'Diversion', value: `<sip:${to}@twilio.com>;reason=unconditional` },
        { name: 'Call-ID', value: callId },
      ],
    } });
const id = `wh_${randomBytes(8).toString('hex')}`;
const ts = String(Math.floor(Date.now() / 1000));
const key = Buffer.from((mode === 'bad' ? `whsec_${randomBytes(32).toString('base64')}` : secret).replace(/^whsec_/, ''), 'base64');
const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body });
console.log(`${mode}: verifier answered ${res.status} ${await res.text()}`);
if (mode !== 'call') process.exit(0);

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const started = Date.now();
while (Date.now() - started < 60_000) {
  await new Promise((r) => setTimeout(r, 3000));
  const row = (await db.send(new GetCommand({ TableName: callsTable, Key: { callId } }))).Item;
  if (row && row.status !== 'claimed') { console.log(`call row: status=${row.status} tenant=${row.tenantId} from=${row.from} to=${row.to} error=${row.error ?? ''}`); process.exit(0); }
}
console.log('no call row within 60 s; check the accept workflow log group');
