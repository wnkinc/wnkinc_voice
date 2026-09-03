/**
 * One turn of the assistant, channel-neutral: a tenant, a person on that
 * tenant, their message -> a reply. Everything Telegram-shaped stays outside.
 *
 * Order of business: the tenant row (fail closed: unknown tenant or service
 * off means no reply), the Gateway catalog filtered to what this tenant has,
 * what memory knows about this person and business, then one run of the
 * OpenAI Agents SDK, which owns the tool loop. The turn is written back to
 * memory so the managed strategies extract facts for next time.
 */
import { Agent, run, tool, type AgentInputItem } from '@openai/agents';
import { personActorId, requireTenant, type CallerMemory, type GatewayClient, type Person, type Store, type TenantConfig } from '@wnk/shared';
import { prepareTools, type PreparedTool } from './tools.js';

export interface TurnPayload {
  tenantId: string;
  person: Pick<Person, 'name' | 'role'>;
  /** The channel identity that was looked up, e.g. `telegram:12345`. Keys memory and the in-process thread. */
  channelId: string;
  text: string;
}

export interface TurnResult {
  reply?: string;
  skipped?: string;
  tokens: number;
}

export interface CoreDeps {
  store: Store;
  gateway?: GatewayClient;
  memory?: CallerMemory;
  model: string;
}

// In-process thread per channel identity. AgentCore Runtime pins a session id
// to one microVM, so this survives across turns of a conversation and is gone
// when the session idles out; long-term knowledge is memory's job.
const threads = new Map<string, AgentInputItem[]>();
const THREAD_ITEMS = 40;

function trimThread(items: AgentInputItem[]): AgentInputItem[] {
  if (items.length <= THREAD_ITEMS) return items;
  // Cut at a user message so a tool call is never separated from its result.
  const start = items.findIndex((it, i) => i >= items.length - THREAD_ITEMS && 'role' in it && it.role === 'user');
  return start > 0 ? items.slice(start) : items;
}

export function instructions(tenant: TenantConfig, person: TurnPayload['person'], memories: string[]): string {
  const lines = [
    `You are My Assistant for ${tenant.businessName}, chatting with ${person.name} (${person.role}) who works there.`,
    tenant.description ? `About the business: ${tenant.description}` : '',
    tenant.services.length ? `Services: ${tenant.services.join(', ')}.` : '',
    tenant.hours ? `Hours: ${tenant.hours}.` : '',
    `Time zone: ${tenant.timezone}. Today is ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'This is a chat, so be brief and concrete: plain text, no markdown, no headings.',
    'Use your tools to look things up or record things; say what you did and what you found. Never invent records.',
    'If a request needs a tool you do not have, say so in one sentence.',
    'When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered.',
  ];
  if (memories.length) lines.push('', 'Remembered about this person and the business:', ...memories.map((m) => `- ${m}`));
  return lines.filter((l) => l !== undefined).join('\n');
}

function asSdkTool(p: PreparedTool, gateway: GatewayClient) {
  return tool({
    name: p.name,
    description: p.description,
    parameters: p.parameters,
    strict: false,
    execute: async (args) => gateway.callTool(p.name, p.callArgs((args ?? {}) as Record<string, unknown>)),
  });
}

export async function handleTurn(deps: CoreDeps, payload: TurnPayload): Promise<TurnResult> {
  const tenant = await requireTenant(deps.store, payload.tenantId);
  if (!tenant.products.assistant.enabled) {
    console.log(JSON.stringify({ msg: 'assistant not enabled for tenant; ignoring', tenantId: tenant.tenantId }));
    return { skipped: 'assistant not enabled for this tenant', tokens: 0 };
  }
  const actorId = personActorId(tenant.tenantId, payload.channelId);

  const catalog = deps.gateway ? await deps.gateway.listTools() : [];
  const prepared = prepareTools(catalog, tenant);
  const tools = deps.gateway ? prepared.map((p) => asSdkTool(p, deps.gateway!)) : [];

  let memories: string[] = [];
  if (deps.memory) {
    try {
      memories = await deps.memory.recallActor(actorId, payload.text);
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'memory recall unavailable; continuing', err: String(err) }));
    }
  }

  const agent = new Agent({ name: 'My Assistant', model: deps.model, instructions: instructions(tenant, payload.person, memories), tools });
  const history = threads.get(payload.channelId) ?? [];
  const result = await run(agent, [...history, { role: 'user', content: payload.text }]);
  threads.set(payload.channelId, trimThread(result.history));

  const reply = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput ?? '');
  const tokens = result.rawResponses.reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0);
  console.log(JSON.stringify({ msg: 'turn complete', tenantId: tenant.tenantId, actorId, tools: prepared.map((p) => p.name), toolCalls: result.newItems.filter((i) => i.type === 'tool_call_item').length, tokens }));

  if (deps.memory) {
    try {
      await deps.memory.recordTurns(actorId, payload.channelId, [{ role: 'user', text: payload.text }, { role: 'assistant', text: reply }]);
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'memory write failed; continuing', err: String(err) }));
    }
  }
  return { reply, tokens };
}
