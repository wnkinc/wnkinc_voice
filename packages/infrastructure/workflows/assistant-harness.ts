/**
 * My Assistant's harness: the rented agent loop on AgentCore Runtime. It has
 * no definition here; it is declared in stacks/runtime-stack.ts (model, tool
 * allow-list, memory retrieval). This file holds only its catalog entry.
 */
import type { UnitOutcomes } from '@wnk/shared';

/** The four answers the catalog shows for this unit (see UnitOutcomes). */
export const outcomes: UnitOutcomes = {
  in: 'One invocation per Telegram message from the Telegram workflow: the message, the tenant\'s prompt, the tenant\'s Composio MCP session, and the person\'s memory actor id.',
  out: 'A reply, produced by the model with up to the allowed number of tool rounds against the tenant\'s connected accounts, and the conversation saved to memory.',
  also: 'Tool calls in HubSpot and Gmail as the owner\'s connected accounts allow, including writes.',
  fails: 'An error is returned to the Telegram workflow, whose execution fails and alarms. The harness itself has no alarm.',
};
