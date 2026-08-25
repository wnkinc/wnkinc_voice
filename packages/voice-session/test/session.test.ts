import type { Context, SQSEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createSessionHandler } from '../src/session.js';
import { silentLog } from './helpers.js';

const record = (callId: string, body?: string) => ({
  messageId: `m-${callId}`,
  body: body ?? JSON.stringify({ callId, tenantPhoneNumber: '+15555550100', startedAt: new Date().toISOString() }),
});
const event = (...records: ReturnType<typeof record>[]) => ({ Records: records }) as SQSEvent;
const context = { getRemainingTimeInMillis: () => 600_000 } as Context;

describe('session handler', () => {
  it('runs the call and reports no failures on success', async () => {
    const runCall = vi.fn(async () => ({ status: 'completed' as const, durationSeconds: 10, transcript: [] }));
    const handler = createSessionHandler({ runCall, log: silentLog });
    const res = await handler(event(record('a')), context);
    expect(runCall).toHaveBeenCalledWith(expect.objectContaining({ callId: 'a' }), expect.any(Number));
    expect(res.batchItemFailures).toEqual([]);
  });

  it('derives the call deadline from the Lambda deadline, minus headroom', async () => {
    let deadline = 0;
    const handler = createSessionHandler({
      runCall: async (_job, deadlineMs) => { deadline = deadlineMs; return undefined; },
      log: silentLog,
    });
    const before = Date.now();
    await handler(event(record('a')), context);
    expect(deadline).toBeGreaterThan(before + 500_000);
    expect(deadline).toBeLessThan(before + 600_000);
  });

  it('reports the message for retry when the call throws', async () => {
    const handler = createSessionHandler({ runCall: async () => { throw new Error('ws refused'); }, log: silentLog });
    const res = await handler(event(record('b')), context);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-b' }]);
  });

  it('drops unparseable jobs without reporting a failure', async () => {
    const runCall = vi.fn();
    const handler = createSessionHandler({ runCall, log: silentLog });
    const res = await handler(event(record('c', 'not json'), record('d', '{"callId":"d"}')), context);
    expect(runCall).not.toHaveBeenCalled();
    expect(res.batchItemFailures).toEqual([]);
  });
});
