import { describe, expect, it, vi } from 'vitest';
import { CallPoller, type QueueClient, type QueueMessage } from '../src/worker.js';
import { silentLog } from './helpers.js';

function fakeQueue(initial: QueueMessage[] = []) {
  const pending = [...initial];
  const deleted: string[] = [];
  const visibility: Array<[string, number]> = [];
  const q: QueueClient = {
    receive: vi.fn(async (max) => pending.splice(0, max)),
    extendVisibility: vi.fn(async (h, s) => { visibility.push([h, s]); }),
    delete: vi.fn(async (h) => { deleted.push(h); }),
  };
  return { q, deleted, visibility, pending };
}

const job = (callId: string) => ({
  receiptHandle: `rh-${callId}`,
  body: JSON.stringify({ callId, tenantPhoneNumber: '+15555550100', startedAt: new Date().toISOString() }),
});

describe('CallPoller', () => {
  it('deletes the message after the call completes', async () => {
    const { q, deleted } = fakeQueue();
    const runCall = vi.fn(async () => ({ status: 'completed' as const, durationSeconds: 10, transcript: [] }));
    const p = new CallPoller({ queue: q, log: silentLog, maxConcurrentCalls: 2, maxCallMs: 60_000, runCall, heartbeatMs: 10 });
    await p.handle(job('a'));
    expect(runCall).toHaveBeenCalledOnce();
    expect(deleted).toEqual(['rh-a']);
    expect(p.activeCount).toBe(0);
  });

  it('keeps the message (for retry) when the call throws', async () => {
    const { q, deleted } = fakeQueue();
    const p = new CallPoller({ queue: q, log: silentLog, maxConcurrentCalls: 2, maxCallMs: 60_000, heartbeatMs: 10,
      runCall: async () => { throw new Error('ws refused'); } });
    await p.handle(job('b'));
    expect(deleted).toEqual([]);
  });

  it('releases the message immediately when the session is detached', async () => {
    const { q, deleted, visibility } = fakeQueue();
    const p = new CallPoller({ queue: q, log: silentLog, maxConcurrentCalls: 2, maxCallMs: 60_000, heartbeatMs: 10,
      runCall: async (_j, _d, onStart) => {
        onStart({ detach: () => {} });
        return { status: 'in_progress' as const, durationSeconds: 5, transcript: [], detached: true };
      } });
    await p.handle(job('c'));
    expect(deleted).toEqual([]);
    expect(visibility.at(-1)).toEqual(['rh-c', 0]);
  });

  it('heartbeats visibility while a call is running', async () => {
    const { q, visibility } = fakeQueue();
    let finish!: () => void;
    const p = new CallPoller({ queue: q, log: silentLog, maxConcurrentCalls: 2, maxCallMs: 60_000, heartbeatMs: 5, visibilitySeconds: 42,
      runCall: () => new Promise((r) => { finish = () => r({ status: 'completed', durationSeconds: 1, transcript: [] }); }) });
    const done = p.handle(job('d'));
    await new Promise((r) => setTimeout(r, 30));
    finish();
    await done;
    expect(visibility.length).toBeGreaterThanOrEqual(2);
    expect(visibility[0]).toEqual(['rh-d', 42]);
  });

  it('drops unparseable messages', async () => {
    const { q, deleted } = fakeQueue();
    const p = new CallPoller({ queue: q, log: silentLog, maxConcurrentCalls: 2, maxCallMs: 60_000, heartbeatMs: 10, runCall: vi.fn() });
    await p.handle({ receiptHandle: 'junk', body: '{not json' });
    expect(deleted).toEqual(['junk']);
  });

  it('stop() detaches live sessions and run() drains', async () => {
    const { q } = fakeQueue([job('e')]);
    const detach = vi.fn();
    const p = new CallPoller({ queue: q, log: silentLog, maxConcurrentCalls: 2, maxCallMs: 60_000, heartbeatMs: 10,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      runCall: (_j, _d, onStart) => new Promise((resolve) => {
        onStart({ detach: () => { detach(); resolve({ status: 'in_progress', durationSeconds: 1, transcript: [], detached: true }); } });
      }) });
    const running = p.run();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.activeCount).toBe(1);
    p.stop();
    await running;
    expect(detach).toHaveBeenCalledOnce();
    expect(p.activeCount).toBe(0);
  });
});
