/**
 * Lead email: lead.recorded -> this workflow -> Composio HTTP -> Gmail.
 *
 * Deterministic, no model. Reads the tenant row, checks the flag and the
 * once-marker, fetches what already exists (the CRM contact and its last
 * note through Composio, caller memory), and formats the owner's email from
 * those fields. Every Composio call names the tenant as Composio's user_id;
 * the API key rides in an EventBridge Connection. Enrichment is best effort
 * (Catch -> continue); the profile lookup and the send fail the execution,
 * which alarms. The once-marker is written after the send: hardening
 * against redelivery, not exactly-once. Toolkit versions are not pinned
 * here (dev); pin in prod with a `version` field on the execute bodies.
 */
import { checkDone, composio, hasCrm, markDone, q } from '../asl.js';
import type { Automation } from './automation.js';

export interface LeadEmailRefs {
  tenantsTable: string;
  callsTable: string;
  usageTable: string;
  composioConnectionArn: string;
  /** Caller memory to recall preferences from; omit and the RecallMemory state is not emitted. */
  memoryId?: string;
}

export function leadEmailDefinition(refs: LeadEmailRefs) {
  const tenantId = q('$tenant.tenantId.S');
  const saas = composio(refs.composioConnectionArn, tenantId);
  const onceKey = q("'done:email:lead:' & $states.input.detail.lead.leadId");
  const lead = '$states.input.detail.lead';
  const phoneFilter = (propertyName: string) => ({ filters: [{ propertyName, operator: 'EQ', value: q(`${lead}.phone`) }] });
  // The email, from existing data only. JSONata strings: no quotes or apostrophes inside.
  const noteText = "$substring($replace($replace($replace($note.hs_note_body, /<br[^>]*>/, '\\n'), /<[^>]+>/, ''), '&nbsp;', ' '), 0, 800)";
  const bodyExpr = [
    "'New lead from the phone receptionist.\\n\\n'",
    `'Name: ' & ${lead}.callerName & '\\n'`,
    `'Phone: ' & ($exists(${lead}.phone) ? ${lead}.phone : 'not provided') & '\\n'`,
    `'Reason: ' & ${lead}.reason & '\\n'`,
    `($exists(${lead}.preferredCallbackTime) ? 'Preferred callback: ' & ${lead}.preferredCallbackTime & '\\n' : '')`,
    `($exists(${lead}.notes) ? 'Notes: ' & ${lead}.notes & '\\n' : '')`,
    "'\\nCRM: ' & ($exists($contact) ? 'known contact ' & $trim(($exists($contact.properties.firstname) and $contact.properties.firstname != null ? $contact.properties.firstname : '') & ' ' & ($exists($contact.properties.lastname) and $contact.properties.lastname != null ? $contact.properties.lastname : '')) & ' ' & $contact.url"
      + ` & ($exists($note.hs_note_body) ? '\\nLast note (' & $substring($note.hs_createdate, 0, 10) & '):\\n' & ${noteText} : '\\nNo notes on this contact yet.')`
      + " : 'no matching contact.') & '\\n'",
    // Preference records arrive as JSON text; show their preference sentence, not the blob.
    "($count($memories) > 0 ? '\\nCaller preferences (from earlier calls):\\n' & $join($memories.('- ' & ($substring($, 0, 1) = '{' ? $match($, /\"preference\":\"([^\"]*)\"/)[0].groups[0] : $)), '\\n') & '\\n' : '')",
    `'\\nSuggested text: Hi ' & $split(${lead}.callerName, ' ')[0] & ', this is ' & $tenant.business.M.name.S & '. Thanks for calling about ' & ${lead}.reason & '. When is a good time to talk? Reply here or call ' & $tenant.phoneNumber.S & '.\\n'`,
    "'\\nCall ' & $states.input.detail.callId",
  ].join(' & ');

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'LookupTenant',
    States: {
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
        Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'ResponderEnabled',
      },
      ResponderEnabled: {
        Type: 'Choice',
        Choices: [{ Condition: q('$exists($tenant) and $tenant.emailResponder.M.enabled.BOOL = true'), Next: 'CheckDone' }],
        Default: 'Skipped',
      },
      Skipped: { Type: 'Succeed' },
      CheckDone: {
        ...checkDone(refs.callsTable, onceKey),
        Assign: { done: q('$exists($states.result.Item) and $count($keys($states.result.Item)) > 0') }, Output: q('$states.input'), Next: 'AlreadyEmailed',
      },
      AlreadyEmailed: { Type: 'Choice', Choices: [{ Condition: q('$done'), Next: 'Skipped' }], Default: 'HasCrm' },
      // ---- Enrichment: the tenant's CRM (by its row), best effort ----------
      HasCrm: {
        Type: 'Choice',
        Choices: [{ Condition: q(`$exists(${lead}.phone) and ${hasCrm()}`), Next: 'FindContact' }],
        Default: 'HasPhone',
      },
      FindContact: {
        ...saas.execute('HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', { filterGroups: [phoneFilter('phone'), phoneFilter('mobilephone')], properties: ['firstname', 'lastname', 'phone', 'email'], limit: 1 }),
        Assign: { contact: q('$states.result.ResponseBody.data.results[0]') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasPhone' }],
        Output: q('$states.input'), Next: 'HasContact',
      },
      HasContact: { Type: 'Choice', Choices: [{ Condition: q('$exists($contact.id)'), Next: 'HubspotAccount' }], Default: 'HasPhone' },
      // Notes have no Composio tool; the proxy needs the connected account id.
      HubspotAccount: {
        ...saas.accounts('hubspot'),
        Assign: { accountId: q('$states.result.ResponseBody.items[0].id') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasPhone' }],
        Output: q('$states.input'), Next: 'LastNote',
      },
      LastNote: {
        ...saas.proxy(q('$accountId'), 'POST', '/crm/v3/objects/notes/search', {
          filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: q('$contact.id') }] }],
          sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
          properties: ['hs_note_body', 'hs_timestamp'], limit: 1,
        }),
        Assign: { note: q('$states.result.ResponseBody.data.results[0].properties') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasPhone' }],
        Output: q('$states.input'), Next: 'HasPhone',
      },
      // ---- Enrichment: caller preferences from memory, best effort -----------
      HasPhone: { Type: 'Choice', Choices: [{ Condition: q(`$exists(${lead}.phone)`), Next: refs.memoryId ? 'RecallMemory' : 'OwnerEmail' }], Default: 'OwnerEmail' },
      ...(refs.memoryId ? { RecallMemory: {
        Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:retrieveMemoryRecords',
        Arguments: {
          MemoryId: refs.memoryId,
          // Preferences only: how and when the caller wants to be reached, which the
          // CRM has no field for. Facts and session summaries are the assistant's.
          NamespacePath: q(`'/callers/' & $tenant.tenantId.S & '_' & $replace(${lead}.phone, /[^0-9]/, '') & '/preferences'`),
          SearchCriteria: { SearchQuery: 'how and when this caller prefers to be contacted', TopK: 4 },
        },
        Assign: { memories: q('[$states.result.MemoryRecordSummaries.Content.Text]') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'OwnerEmail' }],
        Output: q('$states.input'), Next: 'OwnerEmail',
      } } : {}),
      // ---- Send from the owner's own Gmail to the owner ----------------------
      OwnerEmail: {
        ...saas.execute('GMAIL_GET_PROFILE', {}),
        Assign: { ownerEmail: q('$states.result.ResponseBody.data.emailAddress') },
        Output: q('$states.input'), Next: 'HasOwnerEmail',
      },
      HasOwnerEmail: { Type: 'Choice', Choices: [{ Condition: q('$exists($ownerEmail)'), Next: 'Send' }], Default: 'NoGmail' },
      NoGmail: { Type: 'Fail', Error: 'NoGmailConnection', Cause: 'No Gmail profile for the tenant in Composio; run scripts/connect-composio.mts <tenantId> gmail' },
      Send: {
        ...saas.execute('GMAIL_SEND_EMAIL', {
          recipient_email: q('$ownerEmail'),
          subject: q(`'New lead: ' & ${lead}.callerName & ' - ' & $substring(${lead}.reason, 0, 60)`),
          body: q(bodyExpr),
        }),
        Assign: { sent: q('$states.result.ResponseBody.successful = true') },
        Output: q('$states.input'), Next: 'SentOk',
      },
      SentOk: { Type: 'Choice', Choices: [{ Condition: q('$sent'), Next: 'MarkDone' }], Default: 'SendRejected' },
      SendRejected: { Type: 'Fail', Error: 'SendRejected', Cause: 'Composio answered 200 but successful=false for GMAIL_SEND_EMAIL; see the execution history' },
      MarkDone: {
        ...markDone(refs.callsTable, onceKey, { conditional: true }),
        // Marked meanwhile by a concurrent delivery: the email went out either way, so still meter it.
        Catch: [{ ErrorEquals: ['DynamoDB.ConditionalCheckFailedException'], Output: q('$states.input'), Next: 'UsageEmail' }],
        Output: q('$states.input'), Next: 'UsageEmail',
      },
      UsageEmail: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
        Arguments: { TableName: refs.usageTable, Item: {
          tenantId: { S: tenantId },
          sk: { S: q("$now() & '#emails_sent#' & $uuid()") },
          meter: { S: 'emails_sent' },
          units: { N: '1' },
          ref: { S: q('$states.input.detail.callId') },
        } },
        End: true,
      },
    },
  };
}

/** The stock lead email, as a tenant automation. */
export const leadEmail: Automation = {
  name: 'lead-email', on: 'lead.recorded', express: true, timeoutMinutes: 5,
  needs: { tenants: true, calls: true, usage: true, composio: true, memory: true },
  definition: leadEmailDefinition,
};
