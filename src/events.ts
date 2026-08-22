import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { env, type Logger } from './config.js';
import type { VoiceEvent } from './types.js';

export interface EventPublisher {
  publish(event: VoiceEvent): Promise<void>;
}

/** Publishes domain events to the EventBridge bus. A rule routes them to the notifier (later: Temporal). */
export function eventBridgePublisher(): EventPublisher {
  if (!env.eventBusName) throw new Error('EVENT_BUS_NAME not set');
  const client = new EventBridgeClient({});
  return {
    async publish(event) {
      const { type, ...detail } = event;
      const res = await client.send(new PutEventsCommand({
        Entries: [{ EventBusName: env.eventBusName, Source: env.eventSource, DetailType: type, Detail: JSON.stringify(detail) }],
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
