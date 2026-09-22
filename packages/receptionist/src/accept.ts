/**
 * Accept: verified webhook -> tenant -> claim -> recognize -> accept -> enqueue.
 *
 * Invoked asynchronously by the verifier with the webhook body. Called number
 * -> tenant row is the ONLY place the tenant is chosen: an unknown number
 * rejects the call with SIP 404 and throws (an alarm: a routing problem); an
 * inactive tenant rejects with 603 and returns. The claim is a conditional
 * put, so a re-posted webhook ends as a duplicate. Caller recognition runs
 * BEFORE the accept, while the caller still hears ringing (silence after
 * answer is what a caller notices; ringing is normal): every lookup has a
 * deadline and no retry, so recognition can lose the race but never the
 * call. Its result rides to the session on the queue message. Accept carries
 * the minimum (the session Lambda re-sends the full agent config when it
 * attaches). The CRM reads go through Composio's proxy (the tenant's HubSpot
 * API directly, one account lookup first): the tool route measured ~4 s per
 * search, the proxy under half a second.
 *
 * Plain code on purpose: this is a request handler on the call path, where
 * a cold orchestrator would ring in the caller's ear. Nothing here waits.
 */
import type { KnownCaller, SessionJob, TenantConfig } from '@wnk/shared';

// ---- SIP headers -> numbers (exported for the tests) -------------------------

/** Headers (in priority order) that may carry the called / calling number. Twilio puts the dialed number in Diversion. */
export const SIP_CALLED_HEADERS = ['To', 'Diversion', 'X-Called-Number', 'P-Called-Party-ID', 'X-Twilio-To'];
export const SIP_CALLER_HEADERS = ['From', 'P-Asserted-Identity', 'X-Twilio-From'];

export interface SipHeader { name: string; value: string }

/** E.164 ('+15551234567') from the first of `names` present whose value carries a phone number (sip:/tel: URI, or a bare number). '' when none. */
export function sipNumber(headers: SipHeader[], names: string[]): string {
  for (const n of names) {
    const value = headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
    if (value === undefined) continue;
    const uri = /(?:sips?|tel):\+?([0-9][0-9().\- ]*)/i.exec(value);
    const raw = uri ? uri[1]! : (/^\s*\+?[0-9().\- ]+\s*$/.test(value) ? value : '');
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  }
  return '';
}

/** HubSpot note HTML -> one-line text, as the prompt wants it. */
export const htmlToText = (html: string) => html.replace(/<br[^>]*>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** OpenAI's `realtime.call.incoming` webhook, the parts read here. */
export interface IncomingCall { type: string; id: string; data?: { call_id: string; sip_headers?: SipHeader[] } }

// ---- The handler, over injected side effects ---------------------------------------

export interface AcceptDeps {
  lookupTenant(phoneNumber: string): Promise<TenantConfig | undefined>;
  /** The claim on the call row: false when an earlier attempt holds it (a duplicate webhook). */
  claim(row: { callId: string; tenantId: string; tenantPhoneNumber: string; to: string; from?: string; webhookId: string; startedAt: string }): Promise<boolean>;
  setStatus(callId: string, status: 'accepted' | 'failed', error?: string): Promise<void>;
  /** The tenant's HubSpot through Composio's proxy; each call is given a deadline and may throw. */
  crm: {
    account(tenantId: string, signal: AbortSignal): Promise<string | undefined>;
    proxy(tenantId: string, accountId: string, endpoint: string, body: Record<string, unknown>, signal: AbortSignal): Promise<{ results?: Record<string, any>[] }>;
  };
  recallMemory(actorId: string, signal: AbortSignal): Promise<string[]>;
  /** POST realtime/calls/<id>/<accept|reject>; the HTTP status. */
  openai(callId: string, action: 'accept' | 'reject', body: Record<string, unknown>): Promise<number>;
  enqueue(job: SessionJob): Promise<void>;
  now?: () => Date;
}

export type AcceptOutcome = 'ignored' | 'inactive' | 'duplicate' | 'gone' | 'accepted';

/** The ringing budget, per lookup, in ms. They sum to well inside the accept deadline. */
export const BUDGET_MS = { account: 1000, contact: 2000, note: 1000, memory: 1000 };

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const settle = async <T>(p: Promise<T>): Promise<T | undefined> => { try { return await p; } catch { return undefined; } };

export function createAccept(deps: AcceptDeps) {
  return async (event: IncomingCall): Promise<AcceptOutcome> => {
    if (event.type !== 'realtime.call.incoming' || !event.data?.call_id) return 'ignored';
    const callId = event.data.call_id;
    const headers = event.data.sip_headers ?? [];
    const to = sipNumber(headers, SIP_CALLED_HEADERS);
    const from = sipNumber(headers, SIP_CALLER_HEADERS);
    const startedAt = (deps.now?.() ?? new Date()).toISOString();

    const tenant = to ? await deps.lookupTenant(to) : undefined;
    if (!tenant) {
      await settle(deps.openai(callId, 'reject', { status_code: 404 }));
      throw new Error(`UnknownCalledNumber: no tenant row for ${to || '(no called number)'}; rejected with SIP 404. Check the Twilio trunk numbers against the Tenants table.`);
    }
    if (tenant.active === false) {
      await deps.openai(callId, 'reject', { status_code: 603 });
      return 'inactive';
    }
    // Idempotent across OpenAI's webhook retries; a call whose earlier attempt failed may be re-claimed.
    if (!await deps.claim({ callId, tenantId: tenant.tenantId, tenantPhoneNumber: tenant.phoneNumber, to, ...(from ? { from } : {}), webhookId: event.id, startedAt })) return 'duplicate';

    // ---- Caller recognition, best effort, while it rings: the tenant's CRM, then memory ----
    let knownCaller: KnownCaller | undefined;
    let callerMemory: string[] | undefined;
    if (from) {
      const memory = settle(deps.recallMemory(`${tenant.tenantId}_${from.replace(/[^0-9]/g, '')}`, AbortSignal.timeout(BUDGET_MS.memory)));
      if (tenant.crm?.type === 'hubspot' && tenant.crm.via === 'composio') knownCaller = await recognize(deps, tenant.tenantId, from);
      const memories = await memory;
      if (memories?.length) callerMemory = memories;
    }

    const status = await deps.openai(callId, 'accept', {
      type: 'realtime',
      model: tenant.receptionist.session.model,
      instructions: `You are ${tenant.receptionist.instructions.agentName}, the phone receptionist for ${tenant.business.name}. The call has just connected and the receptionist system will start the conversation in a moment. Until you receive new instructions, do not speak.`,
      audio: { output: { voice: tenant.receptionist.session.audio.output.voice } },
    });
    if (status === 404) {
      // The caller hung up while ringing: not an error worth paging for.
      await deps.setStatus(callId, 'failed', 'call gone before accept');
      return 'gone';
    }
    if (status < 200 || status >= 300) {
      await deps.setStatus(callId, 'failed', 'accept failed');
      throw new Error(`AcceptFailed: OpenAI answered ${status} to the accept; the call row is marked failed`);
    }
    await deps.setStatus(callId, 'accepted');
    await deps.enqueue({
      callId, tenantPhoneNumber: tenant.phoneNumber, startedAt, to, ...(from ? { from } : {}),
      extras: { ...(from ? { callerPhone: from } : {}), ...(knownCaller ? { knownCaller } : {}), ...(callerMemory ? { callerMemory } : {}) },
    });
    return 'accepted';
  };
}

/** The contact by phone and its last note, each under its deadline; whatever loses the race is left out. */
async function recognize(deps: AcceptDeps, tenantId: string, from: string): Promise<KnownCaller | undefined> {
  const accountId = await settle(deps.crm.account(tenantId, AbortSignal.timeout(BUDGET_MS.account)));
  if (!accountId) return undefined;
  const contacts = await settle(deps.crm.proxy(tenantId, accountId, '/crm/v3/objects/contacts/search', {
    filterGroups: [
      { filters: [{ propertyName: 'phone', operator: 'EQ', value: from }] },
      { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: from }] },
    ],
    properties: ['firstname', 'lastname', 'phone'], limit: 1,
  }, AbortSignal.timeout(BUDGET_MS.contact)));
  const contact = contacts?.results?.[0];
  if (!contact?.id) return undefined;
  const known: KnownCaller = { contactId: String(contact.id) };
  const name = `${text(contact.properties?.firstname)} ${text(contact.properties?.lastname)}`.trim();
  if (name) known.name = name;
  const notes = await settle(deps.crm.proxy(tenantId, accountId, '/crm/v3/objects/notes/search', {
    filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: contact.id }] }],
    sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
    properties: ['hs_note_body', 'hs_timestamp'], limit: 1,
  }, AbortSignal.timeout(BUDGET_MS.note)));
  const note = notes?.results?.[0]?.properties as { hs_note_body?: string; hs_createdate?: string } | undefined;
  if (note?.hs_note_body) { known.lastNote = htmlToText(note.hs_note_body); if (note.hs_createdate) known.lastNoteAt = note.hs_createdate; }
  return known;
}

// ---- Production wiring ------------------------------------------------------

import { BedrockAgentCoreClient, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { env, getOpenAISecrets } from '@wnk/shared';

const need = (name: string): string => { const v = process.env[name]; if (!v) throw new Error(`${name} not set`); return v; };
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const sqs = new SQSClient({});
const memory = new BedrockAgentCoreClient({});
let composioKey: Promise<string> | undefined;
const composioApiKey = () => (composioKey ??= new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: need('COMPOSIO_SECRET_ARN') }))
  .then((r) => { const k = (JSON.parse(r.SecretString ?? '{}') as { COMPOSIO_API_KEY?: string }).COMPOSIO_API_KEY; if (!k) throw new Error('COMPOSIO_API_KEY missing from the secret'); return k; })
  .catch((err) => { composioKey = undefined; throw err; }));
const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1/';

export const handler = createAccept({
  lookupTenant: async (phoneNumber) => (await ddb.send(new GetCommand({ TableName: env.tenantsTable, Key: { phoneNumber } }))).Item as TenantConfig | undefined,
  claim: async (row) => {
    try {
      await ddb.send(new PutCommand({
        TableName: env.callsTable, Item: { ...row, status: 'claimed', expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400 },
        ConditionExpression: 'attribute_not_exists(callId) OR #s = :failed', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':failed': 'failed' },
      }));
      return true;
    } catch (err) { if (err instanceof ConditionalCheckFailedException) return false; throw err; }
  },
  setStatus: async (callId, status, error) => {
    await ddb.send(new UpdateCommand({
      TableName: env.callsTable, Key: { callId },
      UpdateExpression: error ? 'SET #s = :s, #e = :e' : 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status', ...(error ? { '#e': 'error' } : {}) }, ExpressionAttributeValues: { ':s': status, ...(error ? { ':e': error } : {}) },
    }));
  },
  crm: {
    account: async (tenantId, signal) => {
      const res = await fetch(`${COMPOSIO_API}connected_accounts?${new URLSearchParams({ user_ids: tenantId, toolkit_slugs: 'hubspot', statuses: 'ACTIVE' })}`, { headers: { 'x-api-key': await composioApiKey() }, signal });
      if (!res.ok) throw new Error(`Composio accounts ${res.status}`);
      return ((await res.json()) as { items?: { id: string }[] }).items?.[0]?.id;
    },
    proxy: async (tenantId, accountId, endpoint, body, signal) => {
      const res = await fetch(`${COMPOSIO_API}tools/execute/proxy`, {
        method: 'POST', headers: { 'x-api-key': await composioApiKey(), 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ endpoint, method: 'POST', connected_account_id: accountId, body }),
      });
      if (!res.ok) throw new Error(`Composio proxy ${res.status}`);
      return ((await res.json()) as { data?: { results?: Record<string, any>[] } }).data ?? {};
    },
  },
  recallMemory: async (actorId, signal) => {
    const memoryId = process.env.MEMORY_ID;
    if (!memoryId) return [];
    const r = await memory.send(new RetrieveMemoryRecordsCommand({ memoryId, namespacePath: `/callers/${actorId}`, searchCriteria: { searchQuery: 'who this caller is, their jobs, and their preferences', topK: 6 } }), { abortSignal: signal });
    return (r.memoryRecordSummaries ?? []).flatMap((m) => (m.content?.text ? [m.content.text] : []));
  },
  openai: async (callId, action, body) => {
    const { OPENAI_API_KEY } = await getOpenAISecrets();
    const res = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.status;
  },
  enqueue: async (job) => { await sqs.send(new SendMessageCommand({ QueueUrl: need('SESSION_QUEUE_URL'), MessageBody: JSON.stringify(job) })); },
});
