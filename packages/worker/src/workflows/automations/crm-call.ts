/**
 * call.ended -> a transcript note on the caller's contact, when the caller
 * is already one. The transcript never rides on the bus: it is read from the
 * call row by id, behind the once-marker.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import type { CallEnded } from '@wnk/shared/contracts';
import { escapeHtml, hasCrm } from '../../rules/automations.js';
import { ok, phoneFilters, type AutomationOutcome } from './common.js';

type Activities = typeof activities;
const rows = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const saas = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds', backoffCoefficient: 2 } });

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
