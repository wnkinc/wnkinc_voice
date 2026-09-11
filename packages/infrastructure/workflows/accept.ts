/**
 * Accept workflow: verified webhook -> tenant -> claim -> accept -> recognize -> enqueue.
 *
 * Express, execution data not logged (SIP headers, phone numbers, the
 * caller's last CRM note). The verifier Lambda starts it with the webhook
 * body. Called number -> tenant row is the ONLY place the tenant is chosen:
 * unknown number rejects 404 and fails (alarm: a routing problem); inactive
 * tenant rejects 603 and succeeds. The claim is a conditional put, so a
 * re-posted webhook ends as a duplicate. Accept carries the minimum (the
 * session Lambda re-sends the full agent config when it attaches); caller
 * recognition then runs with a real time budget and rides to the session
 * on the queue message. The API keys ride in EventBridge Connections
 * (resolved from the secrets at deploy: rotate a key, redeploy).
 */
import { COMPOSIO_API, OPENAI_API, httpTask, q } from '../infra_utils/asl.js';

export interface AcceptRefs {
  tenantsTable: string;
  callsTable: string;
  sessionQueueUrl: string;
  openaiConnectionArn: string;
  composioConnectionArn: string;
  /** Caller memory to recall from; omit and the RecallMemory state is not emitted. */
  memoryId?: string;
}

// ---- Expressions (exported unwrapped so the tests can evaluate them) ---------

/** Headers (in priority order) that may carry the called / calling number. Twilio puts the dialed number in Diversion. */
export const SIP_CALLED_HEADERS = ['To', 'Diversion', 'X-Called-Number', 'P-Called-Party-ID', 'X-Twilio-To'];
export const SIP_CALLER_HEADERS = ['From', 'P-Asserted-Identity', 'X-Twilio-From'];

/**
 * E.164 ('+15551234567') from the first of `names` present in the SIP header
 * list `headersExpr` ([{name, value}]) whose value carries a phone number
 * (sip:/tel: URI, or a bare number). '' when none.
 */
export function sipNumberExpr(headersExpr: string, names: string[]): string {
  return [
    `( $h := ${headersExpr};`,
    '$val := function($n) { $h[$lowercase(name) = $lowercase($n)][0].value };',
    '$e164 := function($v) { (',
    '  $m := $exists($v) ? $match($v, /(?:sips?|tel):\\+?([0-9][0-9().\\- ]*)/i) : [];',
    "  $raw := $count($m) > 0 ? $m[0].groups[0] : (($exists($v) and $contains($v, /^\\s*\\+?[0-9().\\- ]+\\s*$/)) ? $v : '');",
    "  $d := $replace($raw, /[^0-9]/, '');",
    "  ($length($d) >= 7 and $length($d) <= 15) ? '+' & $d : ''",
    ') };',
    `$c := ${JSON.stringify(names)} ~> $map(function($n) { $e164($val($n)) });`,
    "$c := $c[$ != ''];",
    "$count($c) > 0 ? $c[0] : '' )",
  ].join(' ');
}

/** HubSpot note HTML -> one-line text, as the prompt wants it. */
export const htmlToTextExpr = (expr: string) => `$trim($replace($replace($replace(${expr}, /<br[^>]*>/, ' '), /<[^>]+>/, ' '), /\\s+/, ' '))`;

/** '' for a missing or null field (HubSpot returns null for unset properties). */
const strOrEmpty = (expr: string) => `($exists(${expr}) and ${expr} != null ? ${expr} : '')`;

// ---- Definition ----------------------------------------------------------------

export function acceptDefinition(refs: AcceptRefs) {
  const composioHttp = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query?: Record<string, string>) =>
    httpTask(refs.composioConnectionArn, method, COMPOSIO_API + path, body, query);
  const callUrl = (action: 'accept' | 'reject') => q(`'${OPENAI_API}realtime/calls/' & $callId & '/${action}'`);
  const tenantId = q('$tenant.tenantId.S');
  const callKey = { TableName: refs.callsTable, Key: { callId: { S: q('$callId') } } };
  const setStatus = (status: string, error?: string) => ({
    Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
    Arguments: {
      ...callKey,
      UpdateExpression: error ? 'SET #s = :s, #e = :e' : 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status', ...(error ? { '#e': 'error' } : {}) },
      ExpressionAttributeValues: { ':s': { S: status }, ...(error ? { ':e': { S: error } } : {}) },
    },
    Output: q('$states.input'),
  });
  const name = `$trim(${strOrEmpty('$contact.properties.firstname')} & ' ' & ${strOrEmpty('$contact.properties.lastname')})`;
  const sessionJob = [
    '$string($merge([',
    "{'callId': $callId, 'tenantPhoneNumber': $tenant.phoneNumber.S, 'startedAt': $startedAt, 'to': $to},",
    "($from != '' ? {'from': $from} : {}),",
    "{'extras': $merge([",
    "  ($from != '' ? {'callerPhone': $from} : {}),",
    `  ($exists($contact.id) ? {'knownCaller': $merge([{'contactId': $contact.id}, (${name} != '' ? {'name': ${name}} : {}),`,
    `    ($exists($note.hs_note_body) ? {'lastNote': ${htmlToTextExpr('$note.hs_note_body')}, 'lastNoteAt': $note.hs_createdate} : {})])} : {}),`,
    "  ($count($memories) > 0 ? {'callerMemory': $memories} : {})",
    '])}]))',
  ].join(' ');

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'IsIncomingCall',
    States: {
      IsIncomingCall: { Type: 'Choice', Choices: [{ Condition: q("$states.input.type = 'realtime.call.incoming'"), Next: 'Parse' }], Default: 'Ignored' },
      Ignored: { Type: 'Succeed' },
      Parse: {
        Type: 'Pass',
        Assign: {
          callId: q('$states.input.data.call_id'),
          webhookId: q('$states.input.id'),
          startedAt: q('$now()'),
          to: q(sipNumberExpr('$states.input.data.sip_headers', SIP_CALLED_HEADERS)),
          from: q(sipNumberExpr('$states.input.data.sip_headers', SIP_CALLER_HEADERS)),
        },
        Output: q('$states.input'), Next: 'HasCalledNumber',
      },
      HasCalledNumber: { Type: 'Choice', Choices: [{ Condition: q("$to != ''"), Next: 'LookupTenant' }], Default: 'RejectUnknown' },
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$to') } } },
        Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'TenantState',
      },
      TenantState: {
        Type: 'Choice',
        Choices: [
          { Condition: q('$not($exists($tenant))'), Next: 'RejectUnknown' },
          { Condition: q('$tenant.active.BOOL = false'), Next: 'RejectInactive' },
        ],
        Default: 'Claim',
      },
      RejectUnknown: {
        ...httpTask(refs.openaiConnectionArn, 'POST', callUrl('reject'), { status_code: 404 }),
        Catch: [{ ErrorEquals: ['States.ALL'], Next: 'UnknownCalledNumber' }],
        Next: 'UnknownCalledNumber',
      },
      UnknownCalledNumber: { Type: 'Fail', Error: 'UnknownCalledNumber', Cause: 'No tenant row for the called number; rejected with SIP 404. Check the Twilio trunk numbers against the Tenants table.' },
      RejectInactive: { ...httpTask(refs.openaiConnectionArn, 'POST', callUrl('reject'), { status_code: 603 }), Next: 'Rejected' },
      Rejected: { Type: 'Succeed' },
      // Idempotent across OpenAI's webhook retries; a call whose earlier attempt failed may be re-claimed.
      Claim: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
        Arguments: {
          TableName: refs.callsTable,
          Item: q([
            "$merge([{'callId': {'S': $callId}, 'tenantId': {'S': $tenant.tenantId.S}, 'tenantPhoneNumber': {'S': $tenant.phoneNumber.S}, 'to': {'S': $to},",
            "'webhookId': {'S': $webhookId}, 'status': {'S': 'claimed'}, 'startedAt': {'S': $startedAt}, 'expiresAt': {'N': $string($floor($millis() / 1000) + 90 * 86400)}},",
            "($from != '' ? {'from': {'S': $from}} : {})])",
          ].join(' ')),
          ConditionExpression: 'attribute_not_exists(callId) OR #s = :failed',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':failed': { S: 'failed' } },
        },
        Catch: [{ ErrorEquals: ['DynamoDB.ConditionalCheckFailedException'], Next: 'Duplicate' }],
        Output: q('$states.input'), Next: 'Accept',
      },
      Duplicate: { Type: 'Succeed' },
      Accept: {
        ...httpTask(refs.openaiConnectionArn, 'POST', callUrl('accept'), {
          type: 'realtime',
          model: q('$tenant.model.S'),
          instructions: q("'You are ' & $tenant.agentName.S & ', the phone receptionist for ' & $tenant.businessName.S & '. The call has just connected and the receptionist system will start the conversation in a moment. Until you receive new instructions, do not speak.'"),
          audio: { output: { voice: q('$tenant.voice.S') } },
        }),
        Catch: [
          // The caller hung up while ringing: not an error worth paging for.
          { ErrorEquals: ['States.Http.StatusCode.404'], Output: q('$states.input'), Next: 'MarkGone' },
          { ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'MarkFailed' },
        ],
        Output: q('$states.input'), Next: 'MarkAccepted',
      },
      MarkGone: { ...setStatus('failed', 'call gone before accept'), Next: 'Gone' },
      Gone: { Type: 'Succeed' },
      MarkFailed: { ...setStatus('failed', 'accept failed'), Next: 'AcceptFailed' },
      AcceptFailed: { Type: 'Fail', Error: 'AcceptFailed', Cause: 'OpenAI did not accept the call (gone, or an API error); the call row is marked failed' },
      MarkAccepted: { ...setStatus('accepted'), Next: 'HasCrm' },
      // ---- Caller recognition, best effort: the tenant's CRM, then memory ----
      HasCrm: {
        Type: 'Choice',
        Choices: [{ Condition: q("$from != '' and $tenant.crm.M.type.S = 'hubspot' and $tenant.crm.M.via.S = 'composio'"), Next: 'FindContact' }],
        Default: 'HasCaller',
      },
      FindContact: {
        ...composioHttp('POST', 'tools/execute/HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
          user_id: tenantId,
          arguments: {
            filterGroups: [
              { filters: [{ propertyName: 'phone', operator: 'EQ', value: q('$from') }] },
              { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: q('$from') }] },
            ],
            properties: ['firstname', 'lastname', 'phone'], limit: 1,
          },
        }),
        Assign: { contact: q('$states.result.ResponseBody.data.results[0]') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasCaller' }],
        Output: q('$states.input'), Next: 'HasContact',
      },
      HasContact: { Type: 'Choice', Choices: [{ Condition: q('$exists($contact.id)'), Next: 'HubspotAccount' }], Default: 'HasCaller' },
      HubspotAccount: {
        ...composioHttp('GET', 'connected_accounts', undefined, { user_ids: tenantId, toolkit_slugs: 'hubspot', statuses: 'ACTIVE' }),
        Assign: { accountId: q('$states.result.ResponseBody.items[0].id') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasCaller' }],
        Output: q('$states.input'), Next: 'LastNote',
      },
      LastNote: {
        ...composioHttp('POST', 'tools/execute/proxy', {
          endpoint: '/crm/v3/objects/notes/search', method: 'POST', connected_account_id: q('$accountId'),
          body: {
            filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: q('$contact.id') }] }],
            sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
            properties: ['hs_note_body', 'hs_timestamp'], limit: 1,
          },
        }),
        Assign: { note: q('$states.result.ResponseBody.data.results[0].properties') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasCaller' }],
        Output: q('$states.input'), Next: 'HasCaller',
      },
      HasCaller: { Type: 'Choice', Choices: [{ Condition: q("$from != ''"), Next: refs.memoryId ? 'RecallMemory' : 'Enqueue' }], Default: 'Enqueue' },
      ...(refs.memoryId ? { RecallMemory: {
        Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:retrieveMemoryRecords',
        Arguments: {
          MemoryId: refs.memoryId,
          NamespacePath: q("'/callers/' & $tenant.tenantId.S & '_' & $replace($from, /[^0-9]/, '')"),
          SearchCriteria: { SearchQuery: 'who this caller is, their jobs, and their preferences', TopK: 6 },
        },
        Assign: { memories: q('[$states.result.MemoryRecordSummaries.Content.Text]') },
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'Enqueue' }],
        Output: q('$states.input'), Next: 'Enqueue',
      } } : {}),
      Enqueue: {
        Type: 'Task', Resource: 'arn:aws:states:::sqs:sendMessage',
        Arguments: { QueueUrl: refs.sessionQueueUrl, MessageBody: q(sessionJob) },
        End: true,
      },
    },
  };
}
