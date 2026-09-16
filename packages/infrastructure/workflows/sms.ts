/**
 * My Assistant over SMS: Twilio -> API Gateway -> this workflow -> AgentCore harness.
 *
 * The second front door to the same assistant. Twilio posts each inbound
 * text form-encoded, which is not JSON, and API Gateway can hand a state
 * machine only JSON: so the route drops the raw body on a queue (any string
 * goes) and an EventBridge Pipe starts this machine with the message, a
 * one-element array whose `body` is the form string. The first state parses
 * it (a direct start with {"body": ...} is accepted too, for tests). Sender -> person ->
 * tenant as on Telegram, plus one check Telegram cannot make: the number
 * texted must be that person's tenant's number. Then the same harness
 * invocation with the same prompt shape, the tenant's Composio session, and
 * a person-scoped memory actor. The reply is an HTTP task straight to
 * Twilio's Messages API (form-encoded, basic auth through the Connection),
 * addressed with the account SID the inbound post carried, so the URL needs
 * no configuration. Tokens are metered per invocation.
 */
import { q } from './asl.js';

export const TWILIO_API = 'https://api.twilio.com/2010-04-01/';

export interface SmsRefs {
  peopleTable: string;
  tenantsTable: string;
  usageTable: string;
  harnessArn: string;
  /** Identity API key provider holding the Composio key; resolved into the MCP session header at invocation. */
  composioProviderArn: string;
  /** EventBridge Connection with Twilio basic auth (account SID, auth token). */
  twilioConnectionArn: string;
}

// ---- Expressions (exported unwrapped so the tests can evaluate them) ---------

/**
 * A form-encoded body (`a=1&b=x+y%21`) as an object. `+` is a space in form
 * encoding and `$decodeUrlComponent` does not know that, so it is replaced
 * first; a literal plus arrives as %2B and decodes correctly after.
 */
export const parseFormExpr = (bodyExpr: string) =>
  `$merge($map($split(${bodyExpr}, '&'), function($p) { { $decodeUrlComponent($substringBefore($p, '=')): $decodeUrlComponent($replace($substringAfter($p, '='), '+', ' ')) } }))`;

export function smsDefinition(refs: SmsRefs) {
  const prompt = [
    "'You are My Assistant for ' & $tenant.business.M.name.S & ', texting with ' & $person.name.S & ' (' & $person.role.S & ') who works there. '",
    "($exists($tenant.business.M.description.S) ? 'About the business: ' & $tenant.business.M.description.S & ' ' : '')",
    "($exists($tenant.business.M.services.L) and $count($tenant.business.M.services.L) > 0 ? 'Services: ' & $join($tenant.business.M.services.L.S, ', ') & '. ' : '')",
    "($exists($tenant.business.M.hours.S) ? 'Hours: ' & $tenant.business.M.hours.S & '. ' : '')",
    "($exists($tenant.assistant.M.composioMcpUrl.S) ? 'Your tools reach the business systems the owner connected (CRM, email): search for the right tool, then run it; do not stop at search results. CRM phone numbers are stored in E.164 form such as +15095551234, so search the phone property with that exact format. ' : '')",
    "'This is a text message conversation (SMS): be brief and plain, no markdown, no lists. Use your tools to look things up or record things; say what you did and what you found. Never invent records. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 1000 characters.'",
  ].join(' & ');

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'Parse',
    States: {
      // Twilio's form fields (From, To, Body, AccountSid, ...) from the raw
      // body: the pipe delivers [ { body, ... } ], a direct start { body }.
      // A post with no body parses to nothing and is ignored below rather
      // than failing.
      Parse: {
        Type: 'Pass',
        Assign: {
          raw: q("$type($states.input) = 'array' ? $states.input[0].body : $states.input.body"),
        },
        Output: q('$states.input'), Next: 'ParseForm',
      },
      ParseForm: {
        Type: 'Pass',
        Assign: { sms: q(`$exists($raw) ? ${parseFormExpr('$raw')} : {}`) },
        Output: q('$states.input'), Next: 'IsText',
      },
      IsText: {
        Type: 'Choice',
        Choices: [{ Condition: q("$exists($sms.From) and $exists($sms.To) and $exists($sms.AccountSid) and $exists($sms.Body) and $trim($sms.Body) != ''"), Next: 'LookupPerson' }],
        Default: 'Ignored',
      },
      Ignored: { Type: 'Succeed' },
      LookupPerson: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.peopleTable, Key: { channelId: { S: q("'sms:' & $sms.From") } } },
        Assign: { person: q('$states.result.Item ? $states.result.Item : {}') }, Output: q('$states.input'), Next: 'KnownSender',
      },
      // The sender must be listed, and must have texted their own tenant's
      // number: a person of one business texting another business's number
      // is a stranger to it.
      KnownSender: { Type: 'Choice', Choices: [{ Condition: q('$exists($person.tenantPhone) and $person.tenantPhone.S = $sms.To'), Next: 'LookupTenant' }], Default: 'UnknownSender' },
      UnknownSender: { Type: 'Succeed' },
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$person.tenantPhone.S') } } },
        Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'AssistantEnabled',
      },
      AssistantEnabled: {
        Type: 'Choice',
        Choices: [{ Condition: q('$exists($tenant) and $tenant.assistant.M.enabled.BOOL = true and $exists($tenant.assistant.M.composioMcpUrl.S)'), Next: 'Invoke' }],
        Default: 'Ignored',
      },
      Invoke: {
        Type: 'Task', Resource: 'arn:aws:states:::bedrockagentcore:invokeHarness',
        Arguments: {
          HarnessArn: refs.harnessArn,
          // One session per phone PER DAY, rolling at 3 AM tenant-local
          // (sessionDayOffsetMinutes, computed by the seed; 600 = Pacific if
          // unset), as on Telegram. Ids must be >= 33 chars and plain: the
          // number's digits only. One actor per person, tenant-prefixed and
          // channel-named, so a person's chat memory is theirs and not the
          // caller memory of whoever phones from that number.
          RuntimeSessionId: q("'sms-chat-' & $replace($sms.From, /[^0-9]/, '') & '-' & $fromMillis($millis() - ($exists($tenant.sessionDayOffsetMinutes.N) ? $number($tenant.sessionDayOffsetMinutes.N) : 600) * 60000, '[Y0001][M01][D01]') & '-000000000000'"),
          ActorId: q("$tenant.tenantId.S & '_sms_' & $replace($sms.From, /[^0-9]/, '')"),
          Messages: [{ Role: 'user', Content: [{ Text: q('$sms.Body') }] }],
          SystemPrompt: [{ Text: q(prompt) }],
          // The tenant's SaaS tools: its Composio meta-tools session. The row
          // selects it; the key rides by ARN and is resolved from the vault at
          // invocation. Nothing the model or the sender sends can pick another.
          Tools: [{ Type: 'remote_mcp', Name: 'crm', Config: { RemoteMcp: { Url: q('$tenant.assistant.M.composioMcpUrl.S'), Headers: { 'x-api-key': `\${${refs.composioProviderArn}}` } } } }],
          AllowedTools: ['@crm/*'],
          TimeoutSeconds: 120,
        },
        Retry: [{ ErrorEquals: ['BedrockAgentCore.ThrottlingException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
        Assign: { reply: q('$states.result.Output.Message.Content[0].Text'), usage: q('$states.result.Usage') },
        Output: q('$states.input'), Next: 'Reply',
      },
      // Twilio's Messages API wants a form body: Step Functions encodes it.
      // From is the tenant's number (what they texted), To is the sender. A
      // body over Twilio's 1600 characters is rejected here, fails the
      // execution, and alarms; the prompt asks for far less.
      Reply: {
        Type: 'Task', Resource: 'arn:aws:states:::http:invoke',
        Arguments: {
          ApiEndpoint: q(`'${TWILIO_API}Accounts/' & $sms.AccountSid & '/Messages.json'`),
          Method: 'POST',
          Authentication: { ConnectionArn: refs.twilioConnectionArn },
          Headers: { 'content-type': 'application/x-www-form-urlencoded' },
          RequestBody: { To: q('$sms.From'), From: q('$sms.To'), Body: q('$reply') },
          Transform: { RequestBodyEncoding: 'URL_ENCODED' },
        },
        Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 2, MaxAttempts: 1 }],
        Output: q('$states.input'), Next: 'Usage',
      },
      Usage: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
        Arguments: { TableName: refs.usageTable, Item: {
          tenantId: { S: q('$tenant.tenantId.S') },
          sk: { S: q("$now() & '#llm_tokens#' & $uuid()") },
          meter: { S: 'llm_tokens' },
          units: { N: q('$string($usage.TotalTokens)') },
          ref: { S: q("'sms:' & $sms.From") },
        } },
        End: true,
      },
    },
  };
}
