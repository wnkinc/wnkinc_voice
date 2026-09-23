/**
 * The callers' memory (AgentCore Memory), one client. Events are written per
 * actor and session; the service extracts long-term records asynchronously
 * into per-actor namespaces under /callers/<actorId>, which are read back by
 * a relevance query. The actor id starts with the tenant id, so isolation is
 * structural. No memory configured: nothing remembered, nothing recalled,
 * every call answers as if empty.
 */
import { BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';

export interface MemoryLine { role: 'user' | 'assistant'; text: string }

export interface CallerMemory {
  /** What the service extracted about the actor, relevance-ranked by the query; `namespace` narrows to one kind ('/preferences', '/facts') or '' for all. */
  retrieve(actorId: string, namespace: string, query: string, topK: number, signal?: AbortSignal): Promise<string[]>;
  /** A session's earlier turns, oldest first. */
  history(actorId: string, sessionId: string, max?: number): Promise<MemoryLine[]>;
  /** One event of lines into a session; the service extracts from it later. */
  write(actorId: string, sessionId: string, lines: MemoryLine[]): Promise<void>;
}

export function callerMemory(memoryId: string | undefined): CallerMemory {
  const client = new BedrockAgentCoreClient({});
  const texts = (r: { memoryRecordSummaries?: { content?: { text?: string } }[] }) => (r.memoryRecordSummaries ?? []).flatMap((m) => (m.content?.text ? [m.content.text] : []));
  return {
    async retrieve(actorId, namespace, query, topK, signal) {
      if (!memoryId) return [];
      const r = await client.send(new RetrieveMemoryRecordsCommand({ memoryId, namespacePath: `/callers/${actorId}${namespace}`, searchCriteria: { searchQuery: query, topK } }), { abortSignal: signal });
      return texts(r);
    },
    async history(actorId, sessionId, max = 20) {
      if (!memoryId) return [];
      const r = await client.send(new ListEventsCommand({ memoryId, actorId, sessionId, includePayloads: true, maxResults: max }));
      return (r.events ?? [])
        .sort((a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0))
        .flatMap((e) => (e.payload ?? []).flatMap((p) => (p.conversational?.role && p.conversational.content?.text ? [{ role: p.conversational.role.toLowerCase() as MemoryLine['role'], text: p.conversational.content.text }] : [])));
    },
    async write(actorId, sessionId, lines) {
      if (!memoryId || lines.length === 0) return;
      await client.send(new CreateEventCommand({
        memoryId, actorId, sessionId, eventTimestamp: new Date(),
        payload: lines.map((l) => ({ conversational: { role: l.role === 'user' ? 'USER' : 'ASSISTANT', content: { text: l.text } } })),
      }));
    },
  };
}
