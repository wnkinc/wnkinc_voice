/** The person's chat memory (AgentCore Memory): this session's earlier turns, what the service extracted about them, and the turn written back. No memory configured: nothing remembered, the turn still answers. */
import { BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';

const client = new BedrockAgentCoreClient({});
const memoryId = () => process.env.MEMORY_ID;

export interface HistoryMessage { role: string; content: string }

/** This session's earlier turns, oldest first. */
export async function loadHistory(actorId: string, sessionId: string): Promise<HistoryMessage[]> {
  const id = memoryId();
  if (!id) return [];
  const r = await client.send(new ListEventsCommand({ memoryId: id, actorId, sessionId, includePayloads: true, maxResults: 20 }));
  return (r.events ?? [])
    .sort((a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0))
    .flatMap((e) => (e.payload ?? []).flatMap((p) => (p.conversational?.role && p.conversational.content?.text ? [{ role: p.conversational.role.toLowerCase(), content: p.conversational.content.text }] : [])));
}

/** What the Memory service extracted about this person across all their sessions, relevance-ranked by the text. */
export async function recall(actorId: string, text: string): Promise<string[]> {
  const id = memoryId();
  if (!id) return [];
  const r = await client.send(new RetrieveMemoryRecordsCommand({ memoryId: id, namespacePath: `/callers/${actorId}`, searchCriteria: { searchQuery: text, topK: 8 } }));
  return (r.memoryRecordSummaries ?? []).flatMap((m) => (m.content?.text ? [m.content.text] : []));
}

export async function saveTurn(actorId: string, sessionId: string, text: string, reply: string): Promise<void> {
  const id = memoryId();
  if (!id) return;
  await client.send(new CreateEventCommand({
    memoryId: id, actorId, sessionId, eventTimestamp: new Date(),
    payload: [{ conversational: { role: 'USER', content: { text } } }, { conversational: { role: 'ASSISTANT', content: { text: reply } } }],
  }));
}

/** A caller's preferences only: how and when they want to be reached, which the CRM has no field for. Facts and summaries are the assistant's. */
export async function recallPreferences(actorId: string): Promise<string[]> {
  const id = memoryId();
  if (!id) return [];
  const r = await client.send(new RetrieveMemoryRecordsCommand({ memoryId: id, namespacePath: `/callers/${actorId}/preferences`, searchCriteria: { searchQuery: 'how and when this caller prefers to be contacted', topK: 4 } }));
  return (r.memoryRecordSummaries ?? []).flatMap((m) => (m.content?.text ? [m.content.text] : []));
}
