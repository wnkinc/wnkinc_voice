/**
 * lead.recorded -> the owner's email from their own Gmail, with what the CRM
 * and memory already know about the caller. Started by a tenant's rule with
 * the event's detail; the tenant is the event's, resolved to its row here,
 * and every activity takes its id. The flag first, then the once-marker on
 * the call row, the send, the mark after.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import type { LeadRecorded } from '@wnk/shared/contracts';
import { hasCrm, leadEmailBody } from '../../rules/automations.js';
import { orElse } from '../common.js';
import { phoneFilters, type AutomationOutcome } from './common.js';

type Activities = typeof activities;
const rows = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const saas = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds', backoffCoefficient: 2 } });
/** Enrichment: a failure costs only the detail it would have added. */
const bestEffort = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 2 } });
/** The send: one attempt through Composio's own answer; a rejected or unanswered send fails the workflow, which alarms, rather than sending twice. */
const send = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 1 } });

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
