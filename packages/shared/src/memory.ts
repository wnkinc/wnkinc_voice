/**
 * Caller memory on AgentCore Memory: write call transcripts as events, recall
 * extracted facts/preferences. Actor id = `<tenantId>_<phone digits>` so
 * tenant isolation is structural; session id = callId.
 *
 * Note: long-term extraction is asynchronous — a call's facts appear in
 * retrieval minutes after the event is written, not immediately.
 */
import { BedrockAgentCoreClient, CreateEventCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { TranscriptEntry } from './types.js';

export interface CallerMemory {
  /** Store a finished call's transcript as a conversational event. */
  recordCall(tenantId: string, callerPhone: string, callId: string, transcript: TranscriptEntry[]): Promise<void>;
  /** Retrieve extracted memories about a caller (facts + preferences). */
  recall(tenantId: string, callerPhone: string, query: string): Promise<string[]>;
}

export function callerActorId(tenantId: string, callerPhone: string): string {
  return `${tenantId}_${callerPhone.replace(/\D/g, '')}`;
}

/** From the MEMORY_ID env var; undefined when memory isn't wired. */
export function memoryFromEnv(): CallerMemory | undefined {
  const memoryId = process.env.MEMORY_ID;
  return memoryId ? callerMemory(memoryId) : undefined;
}

export function callerMemory(memoryId: string): CallerMemory {
  const client = new BedrockAgentCoreClient({});
  return {
    async recordCall(tenantId, callerPhone, callId, transcript) {
      const payload = transcript
        .filter((t) => t.role === 'user' || t.role === 'assistant')
        .map((t) => ({ conversational: { role: t.role === 'user' ? ('USER' as const) : ('ASSISTANT' as const), content: { text: t.text } } }));
      if (!payload.length) return;
      await client.send(new CreateEventCommand({
        memoryId,
        actorId: callerActorId(tenantId, callerPhone),
        sessionId: callId,
        eventTimestamp: new Date(),
        payload,
      }));
    },
    async recall(tenantId, callerPhone, query) {
      const res = await client.send(new RetrieveMemoryRecordsCommand({
        memoryId,
        namespacePath: `/callers/${callerActorId(tenantId, callerPhone)}`,
        searchCriteria: { searchQuery: query, topK: 6 },
      }));
      return (res.memoryRecordSummaries ?? [])
        .map((r) => (r.content && 'text' in r.content ? (r.content.text ?? '') : ''))
        .filter(Boolean);
    },
  };
}
