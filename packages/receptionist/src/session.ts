/**
 * SQS-triggered session Lambda. Each invocation holds the WebSocket for one call
 * (batch size 1 in infra) and runs it to completion. The event source mapping
 * deletes the message on success; a reported failure makes it visible again for
 * retry, and repeated failures land in the DLQ.
 */
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { runCall, type CallDeps, type CallOutcome } from './call.js';
import type { CalendarReads } from './agent.js';
import { CALENDAR_TOOLS, composioApi, createLogger, getOpenAISecrets, secretValue, type Busy, type Logger } from '@wnk/shared';
import { eventBridgePublisher } from '@wnk/shared';
import { dynamoStore } from '@wnk/shared';
import type { SessionJob } from '@wnk/shared';

/** Wrap up this long before Lambda would kill the invocation mid-call. */
const LAMBDA_DEADLINE_MARGIN_MS = 15_000;
/** A free/busy read during a call: past this the tool answers that booking is unavailable rather than leave the caller in silence. */
const FREE_BUSY_BUDGET_MS = 4_000;

/** Free/busy through Composio's tool as the tenant, pinned, under a deadline: busy intervals only, which is all the endpoint carries. */
export function calendarReads(secretArn: () => string): CalendarReads {
  const composio = composioApi(() => secretValue(secretArn(), 'COMPOSIO_API_KEY'));
  return {
    async busy(tenantId, calendarId, timeMin, timeMax) {
      const r = await composio.executeTool(tenantId, CALENDAR_TOOLS.freeBusy.slug, { timeMin, timeMax, items: [{ id: calendarId }] }, { version: CALENDAR_TOOLS.freeBusy.version, signal: AbortSignal.timeout(FREE_BUSY_BUDGET_MS) });
      if (r.successful !== true) throw new Error(`free/busy: Composio answered successful=false: ${String(r.error ?? '')}`.slice(0, 300));
      return (r.data?.calendars?.[calendarId]?.busy ?? []) as Busy[];
    },
  };
}

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
    // The secret ARN is read on the first booking call, so a session without it still runs calls; the tools then answer that booking is unavailable.
    deps ??= { secrets: getOpenAISecrets, store: dynamoStore(), events: eventBridgePublisher(), log, calendar: calendarReads(() => { const v = process.env.COMPOSIO_SECRET_ARN; if (!v) throw new Error('COMPOSIO_SECRET_ARN not set'); return v; }) };
    return runCall(job, deps, { deadlineMs });
  },
});
