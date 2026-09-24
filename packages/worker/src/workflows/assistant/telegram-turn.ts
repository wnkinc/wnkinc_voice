/**
 * My Assistant over Telegram: one workflow per update (the workflow id is the
 * update id, so a redelivered webhook starts nothing twice). Sender ->
 * person -> tenant, then the loop with the tenant's allowed tools, the reply
 * through the Bot API, the turn written to memory, tokens metered.
 *
 * `/login ...` from the owner, with the browser product on, is the login
 * handoff (browser-login.ts) instead of the assistant: it opens a browser the
 * business signs into, so only the owner may send it. It runs as its own
 * workflow, abandoned by this one, since it outlives the turn by minutes.
 */
import { ParentClosePolicy, proxyActivities, startChild, upsertSearchAttributes } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import { systemPrompt } from '../../rules/assistant.js';
import { TENANT_ID } from '../../search-attributes.js';
import { orElse } from '../common.js';
import { browserLogin } from './browser-login.js';
import { runAssistantLoop, sessionDay } from './loop.js';

type Activities = typeof activities;
const reads = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const replies = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds' } });
const bestEffort = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 2 } });

/** Telegram's Update, the parts read here. */
export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; from?: { id: number }; chat?: { id: number; type?: string } };
}
export type TelegramTurnOutcome = 'ignored' | 'unknown-sender' | 'assistant-off' | 'login-started' | 'replied';

export async function telegramTurn(update: TelegramUpdate): Promise<TelegramTurnOutcome> {
  const m = update.message;
  if (!m?.text || !m.from?.id || m.chat?.type !== 'private') return 'ignored';
  const chatId = m.chat.id;
  const person = await reads.lookupPerson(`telegram:${m.from.id}`);
  if (!person?.tenantPhone) return 'unknown-sender';
  const tenant = await reads.lookupTenant(person.tenantPhone);
  // Known only now: the sender named the tenant, the starter could not.
  if (tenant) upsertSearchAttributes([{ key: TENANT_ID, value: tenant.tenantId }]);

  if (m.text.toLowerCase().startsWith('/login') && person.role === 'owner' && tenant?.browser?.enabled === true) {
    await startChild(browserLogin, {
      workflowId: `browser-login-${tenant.tenantId}-${update.update_id}`,
      args: [{ tenantId: tenant.tenantId, tenantPhoneNumber: tenant.phoneNumber, chatId, text: m.text }],
      parentClosePolicy: ParentClosePolicy.ABANDON,
      typedSearchAttributes: [{ key: TENANT_ID, value: tenant.tenantId }],
    });
    return 'login-started';
  }
  if (!tenant || tenant.assistant?.enabled !== true) return 'assistant-off';

  const tenantId = tenant.tenantId;
  const actorId = `${tenantId}_telegram_${m.from.id}`;
  const sessionId = `telegram-chat-${chatId}-${sessionDay(tenant.sessionDayOffsetMinutes)}`;
  const mcpTools = tenant.assistant?.mcp ?? {};
  const mcpUrl = Object.keys(mcpTools).length > 0 ? await reads.mcpSession(tenantId, mcpTools, tenant.business.timezone) : undefined;
  const turn = await runAssistantLoop({
    tenantId, allowed: tenant.assistant?.tools ?? [], text: m.text, content: m.text, actorId, sessionId, mcpUrl,
    prompt: systemPrompt(tenant, person, 'chat', '', new Date().toISOString()),
  });
  await replies.sendTelegram(chatId, turn.reply);
  await orElse(bestEffort.saveTurn(actorId, sessionId, m.text, turn.reply), undefined);
  await reads.recordUsage(tenantId, `telegram:${chatId}`, turn.tokens, turn.inputTokens, turn.outputTokens);
  return 'replied';
}
