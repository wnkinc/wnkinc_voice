/**
 * CRM sync for a call: call.ended -> this workflow -> a transcript note on the
 * HubSpot contact, when the caller is already a contact.
 *
 * Express, execution data not logged (it handles the transcript). The
 * transcript never rides on the bus; the workflow reads it from the call row
 * by id. Once-marker before, mark after; a failed execution alarms.
 */
import { checkDone, composio, hasCrm, markDone, q } from '../asl.js';
import type { Automation } from './automation.js';

export interface CrmCallRefs {
  tenantsTable: string;
  callsTable: string;
  composioConnectionArn: string;
}

/** HTML-escape a JSONata string expression (HubSpot note bodies are HTML). */
const esc = (expr: string) => `$replace($replace($replace(${expr}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;

export function crmCallDefinition(refs: CrmCallRefs) {
  const crm = composio(refs.composioConnectionArn, q('$tenant.tenantId.S'));
  const onceKey = 'done:crm:call';

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'HasCaller',
    States: {
      HasCaller: { Type: 'Choice', Choices: [{ Condition: q("$exists($states.input.detail.callerPhone) and $states.input.detail.status = 'completed'"), Next: 'CheckDone' }], Default: 'Skipped' },
      Skipped: { Type: 'Succeed' },
      // One read: the marker and the transcript (kept off the bus; fetched by id here).
      CheckDone: {
        ...checkDone(refs.callsTable, onceKey, 'transcript'),
        Assign: { done: q("$exists($states.result.Item.`done:crm:call`)"), transcript: q('[$states.result.Item.transcript.L]') },
        Output: q('$states.input'), Next: 'AlreadyDone',
      },
      AlreadyDone: { Type: 'Choice', Choices: [{ Condition: q('$done or $count($transcript) = 0'), Next: 'Skipped' }], Default: 'LookupTenant' },
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
        Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'HasCrm',
      },
      HasCrm: { Type: 'Choice', Choices: [{ Condition: q(`$exists($states.input.detail.callerPhone) and ${hasCrm()}`), Next: 'FindContact' }], Default: 'Skipped' },
      FindContact: {
        ...crm.execute('HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
          filterGroups: [
            { filters: [{ propertyName: 'phone', operator: 'EQ', value: q('$states.input.detail.callerPhone') }] },
            { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: q('$states.input.detail.callerPhone') }] },
          ],
          properties: ['firstname', 'lastname', 'phone'], limit: 1,
        }),
        Assign: { contact: q('$states.result.ResponseBody.data.results[0]') },
        Output: q('$states.input'), Next: 'HasContact',
      },
      // Only callers already in the CRM get a transcript note.
      HasContact: { Type: 'Choice', Choices: [{ Condition: q('$exists($contact.id)'), Next: 'AddNote' }], Default: 'Skipped' },
      AddNote: {
        ...crm.execute('HUBSPOT_CREATE_NOTE', {
          hs_timestamp: q('$now()'),
          hs_note_body: q([
            "$substring('Call to ' & $tenant.business.M.name.S & ' line - ' & $string($round($states.input.detail.durationSeconds / 60)) & ' min, ' & $states.input.detail.status & '<br><br>'",
            `& $join($transcript[M.role.S != 'tool'].((M.role.S = 'user' ? 'Caller: ' : 'Agent: ') & ${esc('M.text.S')}), '<br>')`,
            "& '<br><br>Call ID: ' & $states.input.detail.callId, 0, 60000)",
          ].join(' ')),
          associations: [{ to: { id: q('$contact.id') }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
        }),
        Output: q('$states.input'), Next: 'MarkDone',
      },
      MarkDone: { ...markDone(refs.callsTable, onceKey), End: true },
    },
  };
}

/** The stock CRM call sync, as a tenant automation. */
export const crmCall: Automation = {
  name: 'crm-call', on: 'call.ended', express: true, timeoutMinutes: 5,
  needs: { tenants: true, calls: true, composio: true },
  definition: crmCallDefinition,
};
