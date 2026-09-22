/**
 * The front doors, one handler each, on the same image as the worker.
 *
 * SMS: Twilio -> API Gateway -> SQS -> `handler` -> a workflow. Twilio posts each text form-encoded; API Gateway drops the raw
 * body on a queue (which gives the start a retry and a dead letter) and this
 * starts `smsTurn` with the parsed fields. The workflow id is Twilio's
 * MessageSid: a redelivered post is refused as a duplicate and nothing runs
 * twice. Telegram: API Gateway -> `telegram` -> a workflow, keyed by the
 * update id, answering 200 at once (Telegram retries anything slow, and a
 * retry is refused as the same id). Neither polls.
 */
import type { APIGatewayProxyHandlerV2, SQSHandler } from 'aws-lambda';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { isRoutable, parseForm } from './sms/inbound.js';
import { TASK_QUEUE } from './version.js';
import { env, secret } from './activities/config.js';

let client: Promise<Client> | undefined;
async function connect(): Promise<Client> {
  const s = await secret(env('TEMPORAL_SECRET_ARN'));
  for (const key of ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_API_KEY']) if (!s[key]) throw new Error(`${key} is empty in the Temporal secret`);
  const connection = await Connection.connect({ address: s.TEMPORAL_ADDRESS, tls: true, apiKey: s.TEMPORAL_API_KEY });
  return new Client({ connection, namespace: s.TEMPORAL_NAMESPACE });
}

export const handler: SQSHandler = async (event) => {
  client ??= connect().catch((err: unknown) => { client = undefined; throw err; });
  const c = await client;
  for (const record of event.Records) {
    const sms = parseForm(record.body);
    if (!isRoutable(sms)) { console.log(JSON.stringify({ msg: 'not a text; ignored', keys: Object.keys(sms) })); continue; }
    try {
      await c.workflow.start('smsTurn', { taskQueue: TASK_QUEUE, workflowId: `sms-${sms.MessageSid}`, args: [{ sms }], workflowIdReusePolicy: 'REJECT_DUPLICATE' });
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) { console.log(JSON.stringify({ msg: 'already started', messageSid: sms.MessageSid })); continue; }
      throw err;
    }
  }
};

export const telegram: APIGatewayProxyHandlerV2 = async (event) => {
  client ??= connect().catch((err: unknown) => { client = undefined; throw err; });
  const c = await client;
  let update: { update_id?: number };
  try { update = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '{}') as { update_id?: number }; } catch { return { statusCode: 200, body: '' }; }
  if (typeof update.update_id !== 'number') return { statusCode: 200, body: '' };
  try {
    await c.workflow.start('telegramTurn', { taskQueue: TASK_QUEUE, workflowId: `telegram-${update.update_id}`, args: [update], workflowIdReusePolicy: 'REJECT_DUPLICATE' });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
  return { statusCode: 200, body: '' };
};
