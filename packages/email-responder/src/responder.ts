/**
 * Email responder — a Lambda on the `lead.recorded` rule.
 *
 * Enriches the lead with CRM context (the tenant's CRM through the Composio
 * adapter) and platform caller memory, drafts a follow-up with OpenAI, and sends
 * it from the owner's own Gmail through Composio, whose vault holds the
 * credential under the tenant id. v1 emails the OWNER (phone leads carry no
 * email address).
 *
 * Tenancy: the event's tenantId selects the row; the row says whether this
 * service is on. No tenant, unknown tenant, or service off means nothing is
 * sent.
 *
 * Failure is loud: any throw fails the invocation, so Lambda's async retries
 * run and the dead-letter queue and its alarm catch what still fails.
 *
 * Credentials the function holds: none. Composio holds the owner's Gmail and
 * CRM under the tenant id, and the OpenAI key comes from Secrets Manager.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { EventBridgeEvent } from 'aws-lambda';
import { callerMemory, currentXrayHeader, dynamoStore, recordUsage, requireTenant, traceIdOf } from '@wnk/shared';
import { composioGmail, crmForTenant } from '@wnk/shared/composio';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};
const REGION = process.env.AWS_REGION ?? 'us-west-2';
const store = dynamoStore();

interface LeadEvent {
  lead?: { leadId?: string; callerName?: string; phone?: string; reason?: string; preferredCallbackTime?: string; notes?: string };
  tenantId?: string;
  callId?: string;
}

// ---- Drafting ---------------------------------------------------------------

let draftTokens = 0; // set by draftEmail per invocation; read by the meter

async function draftEmail(lead: NonNullable<LeadEvent['lead']>, crmContext: string): Promise<{ subject: string; body: string }> {
  draftTokens = 0;
  const fallback = {
    subject: `New lead: ${lead.callerName ?? 'unknown caller'} — ${lead.reason?.slice(0, 60) ?? 'phone inquiry'}`,
    body: [
      `New lead from the phone receptionist:`,
      ``,
      `Name: ${lead.callerName ?? 'unknown'}`,
      `Phone: ${lead.phone ?? 'unknown'}`,
      `Reason: ${lead.reason ?? 'not given'}`,
      lead.preferredCallbackTime ? `Preferred callback: ${lead.preferredCallbackTime}` : '',
      lead.notes ? `Notes: ${lead.notes}` : '',
      crmContext ? `\nCRM context:\n${crmContext.slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n'),
  };
  try {
    const sm = new SecretsManagerClient({ region: REGION });
    const secret = await sm.send(new GetSecretValueCommand({ SecretId: env('OPENAI_SECRET_ARN') }));
    const { OPENAI_API_KEY } = JSON.parse(secret.SecretString ?? '{}') as { OPENAI_API_KEY?: string };
    if (!OPENAI_API_KEY) return fallback;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.EMAIL_MODEL ?? 'gpt-5-mini',
        messages: [
          { role: 'system', content: 'You write short, useful internal emails for a home-services business owner. Reply with a JSON object {"subject": string, "body": string}. The body: 1) summarize the new lead in two sentences, 2) note anything relevant from CRM history, 3) suggest a 2-3 sentence text message the owner could send the lead. Plain text only.' },
          { role: 'user', content: `New lead: ${JSON.stringify(lead)}\n\nCRM history for this caller (JSON, may be empty): ${crmContext.slice(0, 3000)}` },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: { total_tokens?: number } };
    draftTokens = data.usage?.total_tokens ?? 0;
    const parsed = JSON.parse(data.choices[0]?.message.content ?? '{}') as { subject?: string; body?: string };
    if (parsed.subject && parsed.body) return { subject: parsed.subject, body: parsed.body };
    return fallback;
  } catch (err) {
    console.error('draft via OpenAI failed; using template', err);
    return fallback;
  }
}

// ---- The responder ----------------------------------------------------------

export async function processLead(event: LeadEvent): Promise<{ ok: boolean; sentTo?: string; subject?: string; skipped?: string }> {
  const tenant = await requireTenant(store, event.tenantId);
  const tenantId = tenant.tenantId;
  // Every log line of this run carries the ids a Logs Insights query joins on.
  const ctx = { tenantId, callId: event.callId, traceId: traceIdOf(currentXrayHeader()) };
  if (!tenant.products.emailResponder.enabled) {
    console.log(JSON.stringify({ msg: 'email responder not enabled for tenant; skipping', ...ctx }));
    return { ok: true, skipped: 'email responder not enabled for this tenant' };
  }
  const lead = event.lead ?? {};
  // Once per lead: a redelivered event (EventBridge, or Lambda's retries after
  // a failure past the send) must not email the owner twice. Checked before
  // the CRM lookup and the draft, so a duplicate costs nothing.
  const onceKey = `email:lead:${lead.leadId ?? 'unknown'}`;
  if (event.callId && (await store.isDone(event.callId, onceKey))) {
    console.log(JSON.stringify({ msg: 'already emailed; duplicate delivery ignored', ...ctx }));
    return { ok: true, skipped: 'already emailed for this lead' };
  }
  console.log(JSON.stringify({ msg: 'lead received', lead, ...ctx }));

  let crmContext = '';
  if (lead.phone) {
    // The tenant's CRM by its row (none means no lookup, never someone else's).
    const crm = await crmForTenant(tenant);
    if (crm) {
      try {
        const contact = await crm.findContactByPhone(lead.phone);
        if (contact) crmContext = JSON.stringify({ contact, lastNote: (await crm.lastNote(contact.id).catch(() => undefined)) ?? null });
        console.log(JSON.stringify({ msg: 'crm context fetched', found: Boolean(contact), ...ctx }));
      } catch (err) {
        console.warn(JSON.stringify({ msg: 'crm context unavailable; continuing', err: String(err), ...ctx }));
      }
    }
    // Platform caller memory (facts + preferences extracted from past calls).
    if (process.env.MEMORY_ID) {
      try {
        const memories = await callerMemory(env('MEMORY_ID')).recall(tenantId, lead.phone, 'who this caller is, their jobs, and their preferences');
        if (memories.length) crmContext += `\n\nPlatform memory about this caller:\n${memories.map((m) => `- ${m}`).join('\n')}`;
        console.log(JSON.stringify({ msg: 'caller memory recalled', records: memories.length, ...ctx }));
      } catch (err) {
        console.warn(JSON.stringify({ msg: 'caller memory unavailable; continuing', err: String(err), ...ctx }));
      }
    }
  }

  const draft = await draftEmail(lead, crmContext);
  const sentTo = await composioGmail.sendAsOwner(tenantId, draft.subject, draft.body);
  if (event.callId) await store.markDone(event.callId, onceKey);
  console.log(JSON.stringify({ msg: 'email sent', sentTo, subject: draft.subject, ...ctx }));
  await recordUsage(tenantId, 'emails_sent', 1, event.callId);
  if (draftTokens > 0) await recordUsage(tenantId, 'llm_tokens', draftTokens, event.callId);
  return { ok: true, sentTo, subject: draft.subject };
}

export async function handler(event: EventBridgeEvent<string, LeadEvent>): Promise<void> {
  const result = await processLead(event.detail);
  console.log(JSON.stringify({ msg: 'email responder done', tenantId: event.detail.tenantId, callId: event.detail.callId, ...result }));
}
