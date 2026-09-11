/**
 * Caller memory on AgentCore Memory: recall extracted facts/preferences, and
 * write a call transcript (the call-ended workflow does this in production;
 * this client is for the console and scripts). Actor id =
 * `<tenantId>_<phone digits>` so tenant isolation is structural; session id = callId.
 *
 * Note: long-term extraction is asynchronous — a call's facts appear in
 * retrieval minutes after the event is written, not immediately.
 */
import { BedrockAgentCoreClient, CreateEventCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { TranscriptEntry } from './types.js';

interface MemoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface CallerMemory {
  /** Store a finished call's transcript as a conversational event. */
  recordCall(tenantId: string, callerPhone: string, callId: string, transcript: TranscriptEntry[]): Promise<void>;
  /** Retrieve extracted memories about a caller (facts + preferences). */
  recall(tenantId: string, callerPhone: string, query: string): Promise<string[]>;
}

export function callerActorId(tenantId: string, callerPhone: string): string {
  return `${tenantId}_${callerPhone.replace(/\D/g, '')}`;
}

export function callerMemory(memoryId: string): CallerMemory {
  const client = new BedrockAgentCoreClient({});
  const recordTurns = async (actorId: string, sessionId: string, turns: MemoryTurn[]): Promise<void> => {
    const payload = turns
      .filter((t) => t.text)
      .map((t) => ({ conversational: { role: t.role === 'user' ? ('USER' as const) : ('ASSISTANT' as const), content: { text: t.text } } }));
    if (!payload.length) return;
    await client.send(new CreateEventCommand({ memoryId, actorId, sessionId, eventTimestamp: new Date(), payload }));
  };
  const recallActor = async (actorId: string, query: string): Promise<string[]> => {
    const res = await client.send(new RetrieveMemoryRecordsCommand({
      memoryId,
      namespacePath: `/callers/${actorId}`,
      searchCriteria: { searchQuery: query, topK: 6 },
    }));
    return (res.memoryRecordSummaries ?? [])
      .map((r) => (r.content && 'text' in r.content ? (r.content.text ?? '') : ''))
      .filter(Boolean);
  };
  return {
    recordCall: (tenantId, callerPhone, callId, transcript) =>
      recordTurns(callerActorId(tenantId, callerPhone), callId,
        transcript.filter((t): t is TranscriptEntry & { role: 'user' | 'assistant' } => t.role === 'user' || t.role === 'assistant')),
    recall: (tenantId, callerPhone, query) => recallActor(callerActorId(tenantId, callerPhone), query),
  };
}
