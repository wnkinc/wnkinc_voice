import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type OpenAI from 'openai';
import { APIError, InvalidWebhookSignatureError } from 'openai/error';
import { buildAcceptConfig, enabledTools } from './agent.js';
import { createLogger, createOpenAI, currentXrayHeader, env, getOpenAISecrets, type Logger, type OpenAISecrets } from '@wnk/shared';
import { crmForTenant } from '@wnk/shared/composio';
import type { CrmAdapter } from '@wnk/shared';
import { identifyParties } from './sip.js';
import { dynamoStore, type Store } from '@wnk/shared';
import { memoryFromEnv, type CallerMemory } from '@wnk/shared';
import type { KnownCaller, SessionJob, TenantConfig } from '@wnk/shared';

export interface WebhookDeps {
  secrets: () => Promise<OpenAISecrets>;
  openai: (s: OpenAISecrets) => OpenAI;
  store: () => Store;
  /** Hand the call to the session worker (SQS in production). */
  startSession: (job: SessionJob) => Promise<void>;
  /** Tenant's CRM for caller recognition; optional. */
  crmFor?: (tenant: TenantConfig) => Promise<CrmAdapter | undefined>;
  /** Platform caller memory (AgentCore Memory); optional. */
  memory?: CallerMemory;
  /** Max time to spend on CRM lookup before accepting without it. */
  lookupTimeoutMs?: number;
  log?: Logger;
}

/** Look the caller up in the tenant's CRM. Never throws; undefined on miss, error, or timeout. */
export async function lookupKnownCaller(crm: CrmAdapter | undefined, phone: string | undefined, timeoutMs: number, log: Logger): Promise<KnownCaller | undefined> {
  if (!crm || !phone) return undefined;
  const work = (async () => {
    const contact = await crm.findContactByPhone(phone);
    if (!contact) return undefined;
    const note = await crm.lastNote(contact.id).catch(() => undefined);
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || undefined;
    return { contactId: contact.id, name, lastNote: note?.body, lastNoteAt: note?.at } satisfies KnownCaller;
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    log.warn('crm lookup failed', { err });
    return undefined;
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // don't let a late failure surface as unhandled
  }
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * POST /openai/webhook — verify, route to a tenant by called number, claim the
 * call_id (webhook retries are idempotent), accept with the tenant's agent config,
 * hand off to the worker. Must return 2xx quickly; OpenAI retries failures for 72h.
 */
export function createWebhookHandler(deps: WebhookDeps): APIGatewayProxyHandlerV2 {
  const baseLog = deps.log ?? createLogger({ fn: 'webhook' });

  return async (event) => {
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers[k] = v;

    const secrets = await deps.secrets();
    const openai = deps.openai(secrets);

    let webhook: Awaited<ReturnType<OpenAI['webhooks']['unwrap']>>;
    try {
      webhook = await openai.webhooks.unwrap(body, headers, secrets.OPENAI_WEBHOOK_SECRET);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        baseLog.warn('invalid webhook signature');
        return json(400, { error: 'invalid signature' });
      }
      baseLog.error('webhook parse failed', { err });
      return json(400, { error: 'bad payload' });
    }
    if (webhook.type !== 'realtime.call.incoming') {
      baseLog.info('ignoring webhook', { eventType: webhook.type });
      return json(200, { ignored: webhook.type });
    }

    const callId = webhook.data.call_id;
    const log = baseLog.child({ callId, webhookId: webhook.id });
    const party = identifyParties(webhook.data.sip_headers);
    log.info('incoming call', { from: party.from, to: party.to, sipHeaders: webhook.data.sip_headers });

    const store = deps.store();
    const calledNumber = party.to ?? (env.defaultTenantPhone || undefined);
    const tenant = calledNumber ? await store.getTenant(calledNumber) : undefined;
    if (!tenant || !tenant.active) {
      const status = tenant ? 603 : 404;
      log.warn('no active tenant for called number; rejecting', { calledNumber, status });
      await openai.realtime.calls.reject(callId, { status_code: status }).catch((err) => log.error('reject failed', { err }));
      return json(200, { rejected: true });
    }

    const startedAt = new Date().toISOString();
    const [claimed, knownCaller, callerMemory] = await Promise.all([
      store.claimCall({ callId, tenantId: tenant.tenantId, tenantPhoneNumber: tenant.phoneNumber, from: party.from, to: party.to, webhookId: webhook.id, startedAt }),
      tenant.crm && deps.crmFor
        ? deps.crmFor(tenant).then((crm) => lookupKnownCaller(crm, party.from, deps.lookupTimeoutMs ?? 600, log)).catch(() => undefined)
        : Promise.resolve(undefined),
      deps.memory && party.from
        ? deps.memory.recall(tenant.tenantId, party.from, 'who this caller is, their jobs, and their preferences').catch((err) => {
            log.warn('caller memory recall failed', { err });
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    if (!claimed) {
      log.info('duplicate webhook for already-claimed call; ignoring');
      return json(200, { duplicate: true });
    }
    if (knownCaller) log.info('caller recognized', { contactId: knownCaller.contactId, name: knownCaller.name });
    if (callerMemory?.length) log.info('caller memory recalled', { records: callerMemory.length });
    const extras = { callerPhone: party.from, knownCaller, callerMemory };

    try {
      await openai.realtime.calls.accept(callId, await buildAcceptConfig(tenant, extras));
    } catch (err) {
      if (err instanceof APIError && err.status === 404) {
        log.warn('call no longer exists at accept time');
        await store.setCallStatus(callId, 'failed', { error: 'call gone before accept' });
        return json(200, { gone: true });
      }
      log.error('accept failed', { err });
      await store.setCallStatus(callId, 'failed', { error: err instanceof Error ? err.message : String(err) });
      return json(500, { error: 'accept failed' }); // OpenAI retries; claimCall() allows re-claiming a failed call
    }
    await store.setCallStatus(callId, 'accepted');
    log.info('call accepted', { tenantId: tenant.tenantId, model: tenant.model, tools: enabledTools(tenant) });

    try {
      await deps.startSession({ callId, tenantPhoneNumber: tenant.phoneNumber, from: party.from, to: party.to, startedAt, extras });
    } catch (err) {
      // The call is live; it just won't have tool execution. Surface loudly.
      log.error('failed to enqueue session', { err });
      await store.setCallStatus(callId, 'failed', { error: 'session enqueue failed' });
    }
    return json(200, { accepted: true });
  };
}

/** Production: enqueue for the session Lambda, which runs the call to completion. */
export function sqsSessionStarter(queueUrl = env.sessionQueueUrl): WebhookDeps['startSession'] {
  const sqs = new SQSClient({});
  return async (job) => {
    if (!queueUrl) throw new Error('SESSION_QUEUE_URL not set');
    // AWSTraceHeader links the session Lambda's trace to the webhook's, so one
    // X-Ray trace covers accept -> queue -> the whole call.
    const trace = currentXrayHeader();
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(job),
      ...(trace ? { MessageSystemAttributes: { AWSTraceHeader: { DataType: 'String', StringValue: trace } } } : {}),
    }));
  };
}

export const handler: APIGatewayProxyHandlerV2 = createWebhookHandler({
  secrets: getOpenAISecrets,
  openai: createOpenAI,
  store: dynamoStore,
  startSession: sqsSessionStarter(),
  crmFor: crmForTenant,
  memory: memoryFromEnv(),
});
