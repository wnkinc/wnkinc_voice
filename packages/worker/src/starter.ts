/**
 * The SMS front door: Twilio -> API Gateway -> SQS -> this function -> a
 * workflow. Twilio posts each text form-encoded; API Gateway drops the raw
 * body on a queue (which gives the start a retry and a dead letter) and this
 * starts `smsTurn` with the parsed fields. The workflow id is Twilio's
 * MessageSid: a redelivered post is refused as a duplicate and nothing runs
 * twice. Same image as the worker, a different handler; it never polls.
 */
import type { SQSHandler } from 'aws-lambda';
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
