import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { env, type Logger } from './config.js';
import { currentXrayHeader } from './trace.js';
import type { VoiceEvent } from './contracts.js';

export interface EventPublisher {
  publish(event: VoiceEvent): Promise<void>;
}

/** Publishes domain events to the EventBridge bus; rules route them to workflows on the worker. */
export function eventBridgePublisher(): EventPublisher {
  if (!env.eventBusName) throw new Error('EVENT_BUS_NAME not set');
  const client = new EventBridgeClient({});
  return {
    async publish(event) {
      const { type, ...detail } = event;
      // TraceHeader carries the X-Ray trace to the rule targets, so the
      // the workflows appear in the same trace as the call.
      const res = await client.send(new PutEventsCommand({
        Entries: [{ EventBusName: env.eventBusName, Source: env.eventSource, DetailType: type, Detail: JSON.stringify(detail), TraceHeader: currentXrayHeader() }],
      }));
      if (res.FailedEntryCount) throw new Error(`EventBridge rejected ${type}: ${JSON.stringify(res.Entries)}`);
    },
  };
}

export function memoryPublisher(log?: Logger): EventPublisher & { events: VoiceEvent[] } {
  const events: VoiceEvent[] = [];
  return {
    events,
    async publish(event) {
      events.push(event);
      log?.info('event', { eventType: event.type });
    },
  };
}
