/**
 * EC2 session worker. Long-polls the session queue and runs one call per message
 * under systemd (see infra/index.ts user data). A message is deleted only when its
 * call has finished, so a crash or restart mid-call makes it visible again and the
 * next worker re-attaches to the same call_id.
 */
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { runCall, type CallHandle, type CallOutcome } from './call.js';
import { createLogger, env, getOpenAISecrets, type Logger } from './config.js';
import { eventBridgePublisher } from './events.js';
import { dynamoStore } from './store.js';
import type { SessionJob } from './types.js';

/** OpenAI's realtime session cap is 30 min; leave room to wrap up and hang up. */
const MAX_CALL_MS = 29 * 60_000;

export interface QueueMessage {
  receiptHandle: string;
  body: string;
}

/** The slice of SQS the poller needs (faked in tests). */
export interface QueueClient {
  receive(max: number, waitSeconds: number, visibilitySeconds: number): Promise<QueueMessage[]>;
  extendVisibility(receiptHandle: string, seconds: number): Promise<void>;
  delete(receiptHandle: string): Promise<void>;
}

export interface PollerOptions {
  queue: QueueClient;
  log: Logger;
  maxConcurrentCalls: number;
  maxCallMs: number;
  runCall: (job: SessionJob, deadlineMs: number, onStart: (h: CallHandle) => void) => Promise<CallOutcome | undefined>;
  visibilitySeconds?: number;
  heartbeatMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CallPoller {
  private readonly o: Required<PollerOptions>;
  private readonly active = new Map<string, { handle?: CallHandle; done: Promise<void> }>();
  private stopping = false;

  constructor(options: PollerOptions) {
    this.o = { visibilitySeconds: 90, heartbeatMs: 30_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...options };
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Poll until stop() is called, then wait for calls to finish or detach. */
  async run(): Promise<void> {
    this.o.log.info('worker started', { maxConcurrentCalls: this.o.maxConcurrentCalls });
    while (!this.stopping) {
      const slots = this.o.maxConcurrentCalls - this.active.size;
      if (slots <= 0) { await this.o.sleep(500); continue; }
      let messages: QueueMessage[];
      try {
        messages = await this.o.queue.receive(Math.min(10, slots), 20, this.o.visibilitySeconds);
      } catch (err) {
        this.o.log.error('receive failed; backing off', { err });
        await this.o.sleep(5_000);
        continue;
      }
      for (const m of messages) {
        const done = this.handle(m).catch((err) => this.o.log.error('handler crashed', { err }));
        const entry = this.active.get(m.receiptHandle);
        if (entry) entry.done = done;
      }
      if (!messages.length) await this.o.sleep(250); // real SQS long-polls; this only guards a hot loop
    }
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    this.o.log.info('worker stopped');
  }

  /** Stop polling and detach live calls so another worker can resume them. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.o.log.warn('shutdown requested; detaching live calls', { active: this.active.size });
    for (const a of this.active.values()) a.handle?.detach();
  }

  /** Process one message; exposed for tests. */
  async handle(message: QueueMessage): Promise<void> {
    let job: SessionJob;
    try {
      job = JSON.parse(message.body) as SessionJob;
      if (!job.callId || !job.tenantPhoneNumber) throw new Error('missing callId/tenantPhoneNumber');
    } catch (err) {
      this.o.log.error('unparseable job; dropping', { err, body: message.body.slice(0, 200) });
      await this.o.queue.delete(message.receiptHandle);
      return;
    }
    const log = this.o.log.child({ callId: job.callId });
    const entry: { handle?: CallHandle; done: Promise<void> } = { done: Promise.resolve() };
    this.active.set(message.receiptHandle, entry);

    let alive = true;
    const heartbeat = (async () => {
      while (alive) {
        await this.o.sleep(this.o.heartbeatMs);
        if (!alive) break;
        await this.o.queue.extendVisibility(message.receiptHandle, this.o.visibilitySeconds).catch((err) => log.warn('visibility heartbeat failed', { err }));
      }
    })();

    try {
      const startedAt = Date.parse(job.startedAt) || Date.now();
      const deadlineMs = Math.min(startedAt + this.o.maxCallMs, Date.now() + this.o.maxCallMs);
      const outcome = await this.o.runCall(job, deadlineMs, (h) => { entry.handle = h; });
      if (outcome?.detached) {
        await this.o.queue.extendVisibility(message.receiptHandle, 0).catch((err) => log.warn('could not release message', { err }));
        log.info('call released for re-attach');
      } else {
        await this.o.queue.delete(message.receiptHandle);
        log.info('call finished; message deleted', { status: outcome?.status });
      }
    } catch (err) {
      log.error('call failed; leaving message for retry', { err }); // visible again after the timeout; DLQ after N tries
    } finally {
      alive = false;
      this.active.delete(message.receiptHandle);
      await heartbeat;
    }
  }
}

// ---- main -------------------------------------------------------------------

if (process.argv[1] && /worker|index\.mjs$/.test(process.argv[1])) {
  const log = createLogger({ fn: 'worker', pid: process.pid });
  const queueUrl = env.sessionQueueUrl;
  if (!queueUrl) {
    log.error('SESSION_QUEUE_URL not set');
    process.exit(1);
  }
  const sqs = new SQSClient({});
  const queue: QueueClient = {
    async receive(max, waitSeconds, visibilitySeconds) {
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: waitSeconds, VisibilityTimeout: visibilitySeconds }));
      return (res.Messages ?? []).flatMap((m) => (m.ReceiptHandle && m.Body ? [{ receiptHandle: m.ReceiptHandle, body: m.Body }] : []));
    },
    async extendVisibility(receiptHandle, seconds) {
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
    },
    async delete(receiptHandle) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    },
  };
  const deps = { secrets: getOpenAISecrets, store: dynamoStore(), events: eventBridgePublisher(), log };
  const poller = new CallPoller({
    queue,
    log,
    maxConcurrentCalls: env.workerMaxCalls,
    maxCallMs: MAX_CALL_MS,
    runCall: (job, deadlineMs, onStart) => runCall(job, deps, { deadlineMs, onStart }),
  });
  getOpenAISecrets().catch((err) => log.error('secret preload failed', { err }));
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { log.warn(`received ${sig}`); poller.stop(); });
  poller.run().then(() => process.exit(0), (err) => { log.error('worker crashed', { err }); process.exit(1); });
}
