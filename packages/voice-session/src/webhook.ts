/**
 * The verifier: the one piece of the call path that must be code. OpenAI signs
 * each webhook with an HMAC over the raw body; no managed integration computes
 * an HMAC and no API Gateway authorizer can see the body. This function checks
 * the signature and starts the accept workflow (voice stack) with the body.
 * Nothing else: no tenant logic, no SDKs beyond the runtime's AWS SDK.
 *
 * Standard Webhooks scheme: `webhook-signature: v1,<base64 HMAC-SHA256 of
 * "<id>.<timestamp>.<body>">` (several space-separated during rotation), key =
 * the whsec_ secret base64-decoded, timestamp within five minutes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const TOLERANCE_S = 300;

export function verifySignature(secret: string, body: string, headers: Record<string, string | undefined>, nowMs = Date.now()): boolean {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigs = headers['webhook-signature'];
  if (!id || !ts || !sigs || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigs.split(' ').some((s) => {
    const [version, b64] = s.split(',');
    if (version !== 'v1' || !b64) return false;
    const got = Buffer.from(b64, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export interface VerifierDeps {
  secret: () => Promise<string>;
  /** Start the accept workflow with the verified body. */
  start: (body: string) => Promise<void>;
  now?: () => number;
}

export function createVerifier(deps: VerifierDeps) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
    if (!verifySignature(await deps.secret(), body, headers, deps.now?.())) {
      console.warn(JSON.stringify({ msg: 'invalid webhook signature' }));
      return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'invalid signature' }) };
    }
    await deps.start(body);
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accepted: true }) };
  };
}

// ---- Production wiring ------------------------------------------------------

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};
let secretPromise: Promise<string> | undefined;
const sfn = new SFNClient({});
export const handler = createVerifier({
  secret: () => (secretPromise ??= new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: env('OPENAI_SECRET_ARN') }))
    .then((r) => {
      const s = (JSON.parse(r.SecretString ?? '{}') as { OPENAI_WEBHOOK_SECRET?: string }).OPENAI_WEBHOOK_SECRET;
      if (!s || s.startsWith('REPLACE')) throw new Error('OPENAI_WEBHOOK_SECRET is not set in the OpenAI secret');
      return s;
    })
    .catch((err) => { secretPromise = undefined; throw err; })),
  start: async (body) => { await sfn.send(new StartExecutionCommand({ stateMachineArn: env('ACCEPT_WORKFLOW_ARN'), input: body })); },
});
