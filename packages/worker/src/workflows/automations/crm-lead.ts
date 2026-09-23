/**
 * lead.recorded -> the contact upserted, a note, and a follow-up task due the
 * next business morning. The once-marker first, then the tenant's CRM flag;
 * an existing contact only gains the name fields it lacks.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import type { LeadRecorded } from '@wnk/shared/contracts';
import { escapeHtml, hasCrm, nextBusinessMorning, splitName } from '../../rules/automations.js';
import { orElse } from '../common.js';
import { ok, phoneFilters, type AutomationOutcome } from './common.js';

type Activities = typeof activities;
const rows = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const saas = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds', backoffCoefficient: 2 } });
const bestEffort = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 2 } });

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
