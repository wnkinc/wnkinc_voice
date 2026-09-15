/**
 * CRM sync for a lead: lead.recorded -> this workflow -> HubSpot through Composio.
 *
 * Deterministic, no code. Standard (its input is the lead fields, which the
 * owner's email carries anyway). Upserts the contact, adds a note, and adds
 * a follow-up task due the next business morning. Once-marker before, mark
 * after; a failed execution alarms.
 */
import { checkDone, composio, hasCrm, markDone, q } from './asl.js';
import type { Automation } from './automation.js';

export interface CrmLeadRefs {
  tenantsTable: string;
  callsTable: string;
  composioConnectionArn: string;
}

// ---- Expressions (exported unwrapped so the tests can evaluate them) ---------

/**
 * ISO timestamp of the next weekday at 9:00 tenant-local. `offsetExpr` is the
 * seed's sessionDayOffsetMinutes (= 180 - zoneOffsetMinutes). JSONata has no
 * tz database, so after a DST change the hour drifts by one until the next seed.
 */
export function nextBusinessMorningExpr(offsetExpr: string, nowExpr = '$millis()'): string {
  return [
    `( $zone := (180 - ${offsetExpr}) * 60000; $nowMs := ${nowExpr};`,
    '$day := $floor(($nowMs + $zone) / 86400000);',
    '$due := [0..7] ~> $map(function($i) { ( $d := $day + $i; $dow := ($d + 4) % 7; ($dow != 0 and $dow != 6) ? ($d * 86400000 + 9 * 3600000 - $zone) : 0 ) }) ~> $filter(function($t) { $t > $nowMs });',
    '$fromMillis($due[0]) )',
  ].join(' ');
}

/** '' for a missing or null field (HubSpot returns null for unset properties). */
const strOrEmpty = (expr: string) => `($exists(${expr}) and ${expr} != null ? ${expr} : '')`;
/** HTML-escape a JSONata string expression (HubSpot note bodies are HTML). */
const esc = (expr: string) => `$replace($replace($replace(${expr}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;

// ---- Definition ----------------------------------------------------------------

export function crmLeadDefinition(refs: CrmLeadRefs) {
  const crm = composio(refs.composioConnectionArn, q('$tenant.tenantId.S'));
  const lead = '$states.input.detail.lead';
  const onceKey = q("'done:crm:lead:' & $states.input.detail.lead.leadId");
  const nextBusinessMorning = nextBusinessMorningExpr("($exists($tenant.sessionDayOffsetMinutes.N) ? $number($tenant.sessionDayOffsetMinutes.N) : 600)");

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'CheckDone',
    States: {
      CheckDone: {
        ...checkDone(refs.callsTable, onceKey),
        Assign: { done: q('$exists($states.result.Item) and $count($keys($states.result.Item)) > 0') }, Output: q('$states.input'), Next: 'AlreadyDone',
      },
      AlreadyDone: { Type: 'Choice', Choices: [{ Condition: q('$done'), Next: 'Skipped' }], Default: 'LookupTenant' },
      Skipped: { Type: 'Succeed' },
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
        Assign: {
          tenant: q('$states.result.Item'),
          name: q(`$trim(${lead}.callerName)`),
          first: q(`$split($trim(${lead}.callerName), ' ')[0]`),
          last: q(`$trim($substringAfter($trim(${lead}.callerName), ' '))`),
        },
        Output: q('$states.input'), Next: 'HasCrm',
      },
      HasCrm: { Type: 'Choice', Choices: [{ Condition: q(`$exists(${lead}.phone) and ${hasCrm()}`), Next: 'FindContact' }], Default: 'Skipped' },
      FindContact: {
        ...crm.execute('HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
          filterGroups: [
            { filters: [{ propertyName: 'phone', operator: 'EQ', value: q(`${lead}.phone`) }] },
            { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: q(`${lead}.phone`) }] },
          ],
          properties: ['firstname', 'lastname', 'phone'], limit: 1,
        }),
        // Array-wrapped: a new caller matches nothing, and assigning an absent value would fail the execution.
        Assign: { contacts: q('[$states.result.ResponseBody.data.results]') },
        Output: q('$states.input'), Next: 'HasContact',
      },
      HasContact: { Type: 'Choice', Choices: [{ Condition: q('$count($contacts) > 0'), Next: 'MissingNames' }], Default: 'CreateContact' },
      CreateContact: {
        ...crm.execute('HUBSPOT_CREATE_CONTACT', q(`$merge([{'phone': ${lead}.phone}, ($first != '' ? {'firstname': $first} : {}), ($last != '' ? {'lastname': $last} : {})])`)),
        Assign: { contactId: q('$states.result.ResponseBody.data.id') },
        Output: q('$states.input'), Next: 'AddNote',
      },
      // An existing contact only gains the name fields it lacks.
      MissingNames: {
        Type: 'Pass',
        Assign: {
          contactId: q('$contacts[0].id'),
          props: q(`$merge([($first != '' and ${strOrEmpty('$contacts[0].properties.firstname')} = '' ? {'firstname': $first} : {}), ($last != '' and ${strOrEmpty('$contacts[0].properties.lastname')} = '' ? {'lastname': $last} : {})])`),
        },
        Output: q('$states.input'), Next: 'NeedsUpdate',
      },
      NeedsUpdate: { Type: 'Choice', Choices: [{ Condition: q('$count($keys($props)) > 0'), Next: 'UpdateContact' }], Default: 'AddNote' },
      UpdateContact: {
        ...crm.execute('HUBSPOT_UPDATE_CONTACT', { contactId: q('$contactId'), properties: q('$props') }),
        Output: q('$states.input'), Next: 'AddNote',
      },
      AddNote: {
        ...crm.execute('HUBSPOT_CREATE_NOTE', {
          hs_timestamp: q('$now()'),
          hs_note_body: q([
            "'Phone lead via receptionist (' & $tenant.business.M.name.S & ' line)<br><br>'",
            `'Reason: ' & ${esc(`${lead}.reason`)} & '<br>'`,
            `($exists(${lead}.preferredCallbackTime) ? 'Preferred callback: ' & ${esc(`${lead}.preferredCallbackTime`)} & '<br>' : '')`,
            `($exists(${lead}.notes) ? 'Notes: ' & ${esc(`${lead}.notes`)} & '<br>' : '')`,
            "'<br>Call ID: ' & $states.input.detail.callId",
          ].join(' & ')),
          associations: [{ to: { id: q('$contactId') }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
        }),
        Output: q('$states.input'), Next: 'DefaultOwner',
      },
      // The account's first owner gets the task; no owner is not an error.
      DefaultOwner: {
        ...crm.execute('HUBSPOT_RETRIEVE_OWNERS', { limit: 1 }),
        Assign: { ownerId: q('$states.result.ResponseBody.data.results[0].id') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'AddTask' }],
        Output: q('$states.input'), Next: 'AddTask',
      },
      AddTask: {
        ...crm.execute('HUBSPOT_CREATE_TASK', q([
          "$merge([{",
          `'hs_timestamp': ${nextBusinessMorning},`,
          `'hs_task_subject': 'Follow up with ' & $name & ' (' & ${lead}.phone & ')',`,
          `'hs_task_body': ${esc(`${lead}.reason`)} & ($exists(${lead}.preferredCallbackTime) ? '<br>Preferred: ' & ${esc(`${lead}.preferredCallbackTime`)} : ''),`,
          "'hs_task_status': 'NOT_STARTED', 'hs_task_priority': 'MEDIUM', 'hs_task_type': 'TODO',",
          `'associations': [{'to': {'id': $contactId}, 'types': [{'associationCategory': 'HUBSPOT_DEFINED', 'associationTypeId': 204}]}]`,
          "}, ($exists($ownerId) ? {'hubspot_owner_id': $ownerId} : {})])",
        ].join(' '))),
        Output: q('$states.input'), Next: 'MarkDone',
      },
      MarkDone: { ...markDone(refs.callsTable, onceKey), End: true },
    },
  };
}

/** The stock CRM lead sync, as a tenant automation. */
export const crmLead: Automation = {
  name: 'crm-lead', on: 'lead.recorded', timeoutMinutes: 5,
  needs: { tenants: true, calls: true, composio: true },
  definition: crmLeadDefinition,
};
