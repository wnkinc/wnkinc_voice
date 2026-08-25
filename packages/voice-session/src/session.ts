/**
 * SQS-triggered session Lambda. Each invocation holds the WebSocket for one call
 * (batch size 1 in infra) and runs it to completion. The event source mapping
 * deletes the message on success; a reported failure makes it visible again for
 * retry, and repeated failures land in the DLQ.
 */
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { runCall, type CallDeps, type CallOutcome } from './call.js';
import { createLogger, getOpenAISecrets, memoryFromEnv, type Logger } from '@wnk/shared';
import { eventBridgePublisher } from '@wnk/shared';
import { dynamoStore } from '@wnk/shared';
import type { SessionJob } from '@wnk/shared';

/** Wrap up this long before Lambda would kill the invocation mid-call. */
const LAMBDA_DEADLINE_MARGIN_MS = 15_000;

export interface SessionHandlerDeps {
  runCall: (job: SessionJob, deadlineMs: number) => Promise<CallOutcome | undefined>;
  log: Logger;
}

export function createSessionHandler(deps: SessionHandlerDeps) {
  return async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    const deadlineMs = Date.now() + context.getRemainingTimeInMillis() - LAMBDA_DEADLINE_MARGIN_MS;
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    await Promise.all(event.Records.map(async (record) => {
      let job: SessionJob;
      try {
        job = JSON.parse(record.body) as SessionJob;
        if (!job.callId || !job.tenantPhoneNumber) throw new Error('missing callId/tenantPhoneNumber');
      } catch (err) {
        deps.log.error('unparseable job; dropping', { err, body: record.body.slice(0, 200) });
        return; // retrying cannot fix a bad message
      }
      try {
        await deps.runCall(job, deadlineMs);
      } catch (err) {
        deps.log.error('call failed; leaving message for retry', { err, callId: job.callId });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }));
    return { batchItemFailures };
  };
}

const log = createLogger({ fn: 'session' });
let deps: CallDeps | undefined; // built on first use so importing this module needs no env
export const handler = createSessionHandler({
  log,
  runCall: (job, deadlineMs) => {
    deps ??= { secrets: getOpenAISecrets, store: dynamoStore(), events: eventBridgePublisher(), memory: memoryFromEnv(), log };
    return runCall(job, deps, { deadlineMs });
  },
});
