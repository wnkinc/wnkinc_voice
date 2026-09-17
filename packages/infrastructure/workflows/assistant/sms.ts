/**
 * My Assistant over SMS: Twilio -> API Gateway -> SQS -> Pipe -> this workflow -> the agent loop.
 *
 * The second front door to the same assistant. Twilio posts each inbound
 * text form-encoded, which is not JSON, and API Gateway can hand a state
 * machine only JSON: so the route drops the raw body on a queue (any string
 * goes) and an EventBridge Pipe starts this machine with the message, a
 * one-element array whose `body` is the form string. The first state parses
 * it (a direct start with {"body": ...} is accepted too, for tests). Sender ->
 * person -> tenant as on Telegram, plus one check Telegram cannot make: the
 * number texted must be that person's tenant's number. Then the same loop
 * (workflows/assistant/assistant-loop.ts) with the tenant's allowed tools. The reply
 * is an HTTP task straight to Twilio's Messages API (form-encoded, basic
 * auth through the Connection), addressed with the account SID the inbound
 * post carried, so the URL needs no configuration. The turn is written to
 * the person's memory; tokens are metered per turn.
 */
import { q } from '../asl.js';
import { assistantLoopStart, assistantLoopStates, assistantPrepare, assistantSaveTurnState, type AssistantLoopRefs } from './assistant-loop.js';

export const TWILIO_API = 'https://api.twilio.com/2010-04-01/';

export interface SmsRefs extends AssistantLoopRefs {
  peopleTable: string;
  tenantsTable: string;
  usageTable: string;
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
    "($count($allowedTools) > 0 ? 'Your tools reach the business systems the owner connected. Use them to look things up or record things; say what you did and what you found. Never invent records. ' : 'You have no tools connected for this business. ')",
    "'This is a text message conversation (SMS): be brief and plain, no markdown, no lists. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 1000 characters.'",
  ].join(' & ');
  const save = assistantSaveTurnState(refs);

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
        Choices: [{ Condition: q('$exists($tenant) and $tenant.assistant.M.enabled.BOOL = true'), Next: 'Prepare' }],
        Default: 'Ignored',
      },
      // What the loop reads. One memory session per phone PER DAY, rolling at
      // 3 AM tenant-local (sessionDayOffsetMinutes, computed by the seed; 600
      // = Pacific if unset), as on Telegram. One actor per person, tenant-
      // prefixed and channel-named, so a person's chat memory is theirs and
      // not the caller memory of whoever phones from that number. The
      // allow-list is the row's `assistant.tools`.
      Prepare: {
        Type: 'Pass',
        Assign: {
          ...assistantPrepare(),
          text: q('$sms.Body'),
          systemPrompt: q(prompt),
          actorId: q("$tenant.tenantId.S & '_sms_' & $replace($sms.From, /[^0-9]/, '')"),
          sessionId: q("'sms-chat-' & $replace($sms.From, /[^0-9]/, '') & '-' & $fromMillis($millis() - ($exists($tenant.sessionDayOffsetMinutes.N) ? $number($tenant.sessionDayOffsetMinutes.N) : 600) * 60000, '[Y0001][M01][D01]')"),
          allowedTools: q('[$tenant.assistant.M.tools.L.S]'),
        },
        Output: q('$states.input'), Next: assistantLoopStart(refs),
      },
      ...assistantLoopStates(refs, 'Reply'),
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
        Output: q('$states.input'), Next: save ? 'SaveTurn' : 'Usage',
      },
      ...(save ? { SaveTurn: { ...save, Output: q('$states.input'), Next: 'Usage' } } : {}),
      Usage: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
        Arguments: { TableName: refs.usageTable, Item: {
          tenantId: { S: q('$tenant.tenantId.S') },
          sk: { S: q("$now() & '#llm_tokens#' & $uuid()") },
          meter: { S: 'llm_tokens' },
          units: { N: q('$string($tokens)') },
          ref: { S: q("'sms:' & $sms.From") },
        } },
        End: true,
      },
    },
  };
}
