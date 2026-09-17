/**
 * My Assistant: Telegram -> API Gateway -> this workflow -> the agent loop.
 *
 * Input is Telegram's Update object. Sender -> person -> tenant, then the
 * loop (workflows/assistant/assistant-loop.ts) runs the model with the tenant's
 * allowed tools, each executed here through Composio naming the tenant. The
 * reply is published as telegram.reply; the runtime stack's reply rule
 * delivers it. The turn is written to the person's memory; tokens are
 * metered per turn.
 */
import { q } from '../asl.js';
import { assistantLoopStart, assistantLoopStates, assistantPrepare, assistantSaveTurnState, type AssistantLoopRefs } from './assistant-loop.js';

export interface TelegramRefs extends AssistantLoopRefs {
  peopleTable: string;
  tenantsTable: string;
  usageTable: string;
  busName: string;
  /** The browser-login workflow: an owner's `/login` starts it instead of the assistant. */
  browserLoginArn: string;
}

export function telegramDefinition(refs: TelegramRefs) {
  const prompt = [
    "'You are My Assistant for ' & $tenant.business.M.name.S & ', chatting with ' & $person.name.S & ' (' & $person.role.S & ') who works there. '",
    "($exists($tenant.business.M.description.S) ? 'About the business: ' & $tenant.business.M.description.S & ' ' : '')",
    "($exists($tenant.business.M.services.L) and $count($tenant.business.M.services.L) > 0 ? 'Services: ' & $join($tenant.business.M.services.L.S, ', ') & '. ' : '')",
    "($exists($tenant.business.M.hours.S) ? 'Hours: ' & $tenant.business.M.hours.S & '. ' : '')",
    "($count($tenant.assistant.M.tools.L) > 0 ? 'Your tools reach the business systems the owner connected. Use them to look things up or record things; say what you did and what you found. Never invent records. ' : 'You have no tools connected for this business. ')",
    "'This is a chat: be brief and plain, no markdown. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 3000 characters.'",
  ].join(' & ');
  const save = assistantSaveTurnState(refs);

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'IsPrivateText',
    States: {
      IsPrivateText: {
        Type: 'Choice',
        Choices: [{ Condition: q("$exists($states.input.message.text) and $exists($states.input.message.from.id) and $states.input.message.chat.type = 'private'"), Next: 'LookupPerson' }],
        Default: 'Ignored',
      },
      Ignored: { Type: 'Succeed' },
      LookupPerson: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.peopleTable, Key: { channelId: { S: q("'telegram:' & $string($states.input.message.from.id)") } } },
        Assign: { person: q('$states.result.Item ? $states.result.Item : {}') }, Output: q('$states.input'), Next: 'KnownSender',
      },
      KnownSender: { Type: 'Choice', Choices: [{ Condition: q('$exists($person.tenantPhone)'), Next: 'LookupTenant' }], Default: 'UnknownSender' },
      UnknownSender: { Type: 'Succeed' },
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$person.tenantPhone.S') } } },
        Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'IsLogin',
      },
      // `/login ...` from the owner, with the browser product on: the login
      // handoff (workflows/assistant/browser-login.ts), not the assistant. The command
      // opens a browser the business signs into, so only the owner may send it.
      IsLogin: {
        Type: 'Choice',
        Choices: [{ Condition: q("$substring($lowercase($states.input.message.text), 0, 6) = '/login' and $person.role.S = 'owner' and $exists($tenant) and $tenant.browser.M.enabled.BOOL = true"), Next: 'StartLogin' }],
        Default: 'AssistantEnabled',
      },
      StartLogin: {
        Type: 'Task', Resource: 'arn:aws:states:::states:startExecution',
        Arguments: {
          StateMachineArn: refs.browserLoginArn,
          Input: { tenantId: q('$tenant.tenantId.S'), tenantPhoneNumber: q('$tenant.phoneNumber.S'), chatId: q('$states.input.message.chat.id'), text: q('$states.input.message.text') },
        },
        End: true,
      },
      AssistantEnabled: {
        Type: 'Choice',
        Choices: [{ Condition: q('$exists($tenant) and $tenant.assistant.M.enabled.BOOL = true'), Next: 'Prepare' }],
        Default: 'Ignored',
      },
      // What the loop reads. One memory session per chat PER DAY: the day
      // rolls at 3 AM tenant-local (sessionDayOffsetMinutes, computed by the
      // seed; 600 = Pacific if unset). One actor per person, tenant-prefixed
      // and channel-named. The allow-list is the row's `assistant.tools`.
      Prepare: {
        Type: 'Pass',
        Assign: {
          ...assistantPrepare(),
          text: q('$states.input.message.text'),
          systemPrompt: q(prompt),
          actorId: q("$tenant.tenantId.S & '_telegram_' & $string($states.input.message.from.id)"),
          sessionId: q("'telegram-chat-' & $string($states.input.message.chat.id) & '-' & $fromMillis($millis() - ($exists($tenant.sessionDayOffsetMinutes.N) ? $number($tenant.sessionDayOffsetMinutes.N) : 600) * 60000, '[Y0001][M01][D01]')"),
          allowedTools: q('[$tenant.assistant.M.tools.L.S]'),
        },
        Output: q('$states.input'), Next: assistantLoopStart(refs),
      },
      ...assistantLoopStates(refs, 'Reply'),
      Reply: {
        Type: 'Task', Resource: 'arn:aws:states:::events:putEvents',
        Arguments: { Entries: [{
          EventBusName: refs.busName, Source: 'wnkinc.assistant', DetailType: 'telegram.reply',
          Detail: q("$string({'tenantId': $tenant.tenantId.S, 'chatId': $states.input.message.chat.id, 'text': $reply})"),
        }] },
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
          ref: { S: q("'telegram:' & $string($states.input.message.chat.id)") },
        } },
        End: true,
      },
    },
  };
}
