/** The person's chat memory and the callers' call memory (AgentCore Memory, @wnk/shared/memory): this session's earlier turns, what the service extracted, the turn written back. No memory configured: nothing remembered, the turn still answers. */
import { memory } from './clients.js';

export interface HistoryMessage { role: string; content: string }

/** This session's earlier turns, oldest first. */
export const loadHistory = async (actorId: string, sessionId: string): Promise<HistoryMessage[]> =>
  (await memory.history(actorId, sessionId)).map((l) => ({ role: l.role, content: l.text }));

/** What the Memory service extracted about this person across all their sessions, relevance-ranked by the text. */
export const recall = (actorId: string, text: string): Promise<string[]> => memory.retrieve(actorId, '', text, 8);

export const saveTurn = (actorId: string, sessionId: string, text: string, reply: string): Promise<void> =>
  memory.write(actorId, sessionId, [{ role: 'user', text }, { role: 'assistant', text: reply }]);

/** A caller's preferences only: how and when they want to be reached, which the CRM has no field for. Facts and summaries are the assistant's. */
export const recallPreferences = (actorId: string): Promise<string[]> => memory.retrieve(actorId, '/preferences', 'how and when this caller prefers to be contacted', 4);

/** A call's transcript into the caller's memory as one event, the call id as the session; facts and preferences are extracted asynchronously. */
export const rememberCall = (actorId: string, callId: string, lines: { role: 'user' | 'assistant'; text: string }[]): Promise<void> => memory.write(actorId, callId, lines);
