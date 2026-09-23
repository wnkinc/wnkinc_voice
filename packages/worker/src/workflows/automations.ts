/**
 * The tenant automations as workflows. Each is started by a tenant's rule
 * with the bus event's detail and that tenant's options; the tenant is the
 * event's, resolved to its row here, and every activity takes its id. Each
 * checks the tenant's flag first (a service acts for a tenant only if its
 * config enables it) and the once-marker on the call row, and marks after
 * the side effect. Deterministic; every side effect is an activity.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { CallEnded, LeadRecorded, OwnerNotify } from '@wnk/shared/contracts';
import { escapeHtml, hasCrm, leadEmailBody, nextBusinessMorning, splitName } from '../automations/catalog.js';
import { orElse } from './loop.js';

type Activities = typeof activities;
const rows = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const saas = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds', backoffCoefficient: 2 } });
/** Enrichment: a failure costs only the detail it would have added. */
const bestEffort = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 2 } });
/** The send: one attempt through Composio's own answer; a rejected or unanswered send fails the workflow, which alarms, rather than sending twice. */
const send = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 1 } });
const replies = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds' } });

const phoneFilters = (phone: string) => [
  { filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] },
  { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: phone }] },
];
const ok = (r: { successful?: boolean; error?: unknown }, what: string) => {
  if (r.successful !== true) throw ApplicationFailure.nonRetryable(`${what}: Composio answered successful=false: ${String(r.error ?? '')}`.slice(0, 500), 'ComposioRejected');
};

export type AutomationOutcome = 'skipped' | 'done';

/** lead.recorded -> the owner's email from their own Gmail, with what the CRM and memory already know about the caller. */
export async function leadEmail(event: LeadRecorded): Promise<AutomationOutcome> {
  const tenant = await rows.lookupTenant(event.tenantPhoneNumber);
  if (!tenant || tenant.emailResponder?.enabled !== true) return 'skipped';
  const tenantId = tenant.tenantId;
  const key = `done:email:lead:${event.lead.leadId}`;
  if ((await rows.readCall(event.callId, key)).done) return 'skipped';

  // ---- Enrichment, best effort: the tenant's CRM and the caller's preferences ----
  let contact: Awaited<ReturnType<typeof enrich>>['contact'];
  let note: Awaited<ReturnType<typeof enrich>>['note'];
  if (event.lead.phone && hasCrm(tenant)) ({ contact, note } = await enrich(tenantId, event.lead.phone));
  const memories = event.lead.phone ? await orElse(bestEffort.recallPreferences(`${tenantId}_${event.lead.phone.replace(/[^0-9]/g, '')}`), []) : [];

  // ---- Send from the owner's own Gmail to the owner ----------------------
  const profile = await saas.executeTool(tenantId, 'GMAIL_GET_PROFILE', {});
  const ownerEmail = profile.data?.emailAddress as string | undefined;
  if (!ownerEmail) throw ApplicationFailure.nonRetryable('No Gmail profile for the tenant in Composio; run scripts/connect-composio.mts <tenantId> gmail', 'NoGmailConnection');
  const sent = await send.executeTool(tenantId, 'GMAIL_SEND_EMAIL', {
    recipient_email: ownerEmail,
    subject: `New lead: ${event.lead.callerName} - ${event.lead.reason.slice(0, 60)}`,
    body: leadEmailBody(tenant, event, contact, note, memories),
  });
  if (sent.successful !== true) throw ApplicationFailure.nonRetryable('Composio answered successful=false for GMAIL_SEND_EMAIL; see the workflow history', 'SendRejected');
  // Marked meanwhile by a concurrent delivery: the email went out either way, so still meter it.
  await rows.markDone(event.callId, key, true);
  await rows.recordMeter(tenantId, 'emails_sent', 1, event.callId);
  return 'done';
}

async function enrich(tenantId: string, phone: string) {
  const found = await orElse(bestEffort.executeTool(tenantId, 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', { filterGroups: phoneFilters(phone), properties: ['firstname', 'lastname', 'phone', 'email'], limit: 1 }), undefined);
  const contact = found?.data?.results?.[0] as { id: string; url?: string; properties?: Record<string, unknown> } | undefined;
  if (!contact?.id) return { contact: undefined, note: undefined };
  // Notes have no Composio tool; the proxy needs the connected account id.
  const accounts = await orElse(bestEffort.composioAccounts(tenantId, 'hubspot'), []);
  if (!accounts[0]) return { contact, note: undefined };
  const notes = await orElse(bestEffort.composioProxy(tenantId, accounts[0].id, 'POST', '/crm/v3/objects/notes/search', {
    filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: contact.id }] }],
    sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
    properties: ['hs_note_body', 'hs_timestamp'], limit: 1,
  }), undefined);
  return { contact, note: notes?.data?.results?.[0]?.properties as { hs_note_body?: string; hs_createdate?: string } | undefined };
}

/** lead.recorded -> the contact upserted, a note, and a follow-up task due the next business morning. */
export async function crmLead(event: LeadRecorded): Promise<AutomationOutcome> {
  const key = `done:crm:lead:${event.lead.leadId}`;
  if ((await rows.readCall(event.callId, key)).done) return 'skipped';
  const tenant = await rows.lookupTenant(event.tenantPhoneNumber);
  if (!tenant || !event.lead.phone || !hasCrm(tenant)) return 'skipped';
  const tenantId = tenant.tenantId;
  const lead = { ...event.lead, phone: event.lead.phone };
  const { name, first, last } = splitName(lead.callerName);

  const found = await saas.executeTool(tenantId, 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', { filterGroups: phoneFilters(lead.phone), properties: ['firstname', 'lastname', 'phone'], limit: 1 });
  ok(found, 'search contacts');
  const existing = found.data?.results?.[0] as { id: string; properties?: Record<string, unknown> } | undefined;
  let contactId: string;
  if (existing) {
    contactId = existing.id;
    // An existing contact only gains the name fields it lacks.
    const props: Record<string, string> = {};
    if (first && !existing.properties?.firstname) props.firstname = first;
    if (last && !existing.properties?.lastname) props.lastname = last;
    if (Object.keys(props).length > 0) ok(await saas.executeTool(tenantId, 'HUBSPOT_UPDATE_CONTACT', { contactId, properties: props }), 'update contact');
  } else {
    const created = await saas.executeTool(tenantId, 'HUBSPOT_CREATE_CONTACT', { phone: lead.phone, ...(first ? { firstname: first } : {}), ...(last ? { lastname: last } : {}) });
    ok(created, 'create contact');
    contactId = created.data?.id as string;
  }
  ok(await saas.executeTool(tenantId, 'HUBSPOT_CREATE_NOTE', {
    hs_timestamp: new Date().toISOString(),
    hs_note_body: `Phone lead via receptionist (${tenant.business.name} line)<br><br>Reason: ${escapeHtml(lead.reason)}<br>`
      + (lead.preferredCallbackTime ? `Preferred callback: ${escapeHtml(lead.preferredCallbackTime)}<br>` : '')
      + (lead.notes ? `Notes: ${escapeHtml(lead.notes)}<br>` : '')
      + `<br>Call ID: ${event.callId}`,
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
  }), 'add note');
  // The account's first owner gets the task; no owner is not an error.
  const owners = await orElse(bestEffort.executeTool(tenantId, 'HUBSPOT_RETRIEVE_OWNERS', { limit: 1 }), undefined);
  const ownerId = owners?.data?.results?.[0]?.id as string | undefined;
  ok(await saas.executeTool(tenantId, 'HUBSPOT_CREATE_TASK', {
    hs_timestamp: nextBusinessMorning(tenant.sessionDayOffsetMinutes ?? 600, Date.now()),
    hs_task_subject: `Follow up with ${name} (${lead.phone})`,
    hs_task_body: escapeHtml(lead.reason) + (lead.preferredCallbackTime ? `<br>Preferred: ${escapeHtml(lead.preferredCallbackTime)}` : ''),
    hs_task_status: 'NOT_STARTED', hs_task_priority: 'MEDIUM', hs_task_type: 'TODO',
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }],
    ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
  }), 'add task');
  await rows.markDone(event.callId, key);
  return 'done';
}

/** call.ended -> a transcript note on the caller's contact, when the caller is already one. The transcript never rides on the bus. */
export async function crmCall(event: CallEnded): Promise<AutomationOutcome> {
  if (!event.callerPhone || event.status !== 'completed') return 'skipped';
  const key = 'done:crm:call';
  const call = await rows.readCall(event.callId, key, true);
  if (call.done || call.transcript.length === 0) return 'skipped';
  const tenant = await rows.lookupTenant(event.tenantPhoneNumber);
  if (!tenant || !hasCrm(tenant)) return 'skipped';
  const tenantId = tenant.tenantId;
  const found = await saas.executeTool(tenantId, 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', { filterGroups: phoneFilters(event.callerPhone), properties: ['firstname', 'lastname', 'phone'], limit: 1 });
  ok(found, 'search contacts');
  const contact = found.data?.results?.[0] as { id: string } | undefined;
  if (!contact?.id) return 'skipped';
  const lines = call.transcript.filter((t) => t.role !== 'tool').map((t) => `${t.role === 'user' ? 'Caller: ' : 'Agent: '}${escapeHtml(t.text)}`).join('<br>');
  ok(await saas.executeTool(tenantId, 'HUBSPOT_CREATE_NOTE', {
    hs_timestamp: new Date().toISOString(),
    hs_note_body: `Call to ${tenant.business.name} line - ${Math.round(event.durationSeconds / 60)} min, ${event.status}<br><br>${lines}<br><br>Call ID: ${event.callId}`.slice(0, 60000),
    associations: [{ to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
  }), 'add note');
  await rows.markDone(event.callId, key);
  return 'done';
}

/** owner.notify -> the owner's Telegram. No once-marker: an alert delivered twice on a rare redelivery is harmless. A tenant with the tool on but no owner channel fails loudly. */
export async function ownerAlert(event: OwnerNotify): Promise<AutomationOutcome> {
  const tenant = await rows.lookupTenant(event.tenantPhoneNumber);
  const owner = tenant?.people?.find((p) => p.role === 'owner' && p.telegramId);
  if (!tenant || !owner?.telegramId) throw ApplicationFailure.nonRetryable('The tenant has no owner with a Telegram id; add one under people and re-seed', 'NoOwnerChannel');
  await replies.sendTelegram(owner.telegramId, `${event.urgency === 'urgent' ? 'URGENT' : 'Heads up'} (${tenant.business.name}): ${event.summary}${event.callerPhone ? ` Caller: ${event.callerPhone}` : ''}`);
  return 'done';
}

/** call.ended -> transcript to caller memory, minutes to usage. Every tenant gets it identically; a once-marker, since a redelivered event would otherwise double both. */
export async function callEnded(event: CallEnded): Promise<AutomationOutcome> {
  if (event.status !== 'completed' || !(event.durationSeconds > 0)) return 'skipped';
  const key = 'done:call.ended';
  const call = await rows.readCall(event.callId, key, true);
  if (call.done) return 'skipped';
  await rows.recordMeter(event.tenantId, 'voice_minutes', event.durationSeconds / 60, event.callId);
  const lines = call.transcript.filter((t): t is typeof t & { role: 'user' | 'assistant' } => t.role !== 'tool').map((t) => ({ role: t.role, text: t.text }));
  if (event.callerPhone && lines.length > 0) await rows.rememberCall(`${event.tenantId}_${event.callerPhone.replace(/[^0-9]/g, '')}`, event.callId, lines);
  await rows.markDone(event.callId, key);
  return 'done';
}
