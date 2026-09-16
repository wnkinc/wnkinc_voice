/**
 * My Assistant: Telegram -> API Gateway -> this workflow -> AgentCore harness.
 *
 * Input is Telegram's Update object. Sender -> person -> tenant, then the
 * harness is invoked with the message, a prompt built from the tenant row,
 * and the tenant's Composio MCP session (its URL on the row, bound to the
 * owner's connected accounts), so the only SaaS the model can reach is that
 * tenant's. The reply is published as telegram.reply; the runtime stack's
 * reply rule delivers it. Tokens are metered per invocation.
 */
import { q } from './asl.js';

export interface TelegramRefs {
  peopleTable: string;
  tenantsTable: string;
  usageTable: string;
  busName: string;
  harnessArn: string;
  /** Identity API key provider holding the Composio key; resolved into the MCP session header at invocation. */
  composioProviderArn: string;
  /** The browser-login workflow: an owner's `/login` starts it instead of the assistant. */
  browserLoginArn: string;
}

export function telegramDefinition(refs: TelegramRefs) {
  const prompt = [
    "'You are My Assistant for ' & $tenant.business.M.name.S & ', chatting with ' & $person.name.S & ' (' & $person.role.S & ') who works there. '",
    "($exists($tenant.business.M.description.S) ? 'About the business: ' & $tenant.business.M.description.S & ' ' : '')",
    "($exists($tenant.business.M.services.L) and $count($tenant.business.M.services.L) > 0 ? 'Services: ' & $join($tenant.business.M.services.L.S, ', ') & '. ' : '')",
    "($exists($tenant.business.M.hours.S) ? 'Hours: ' & $tenant.business.M.hours.S & '. ' : '')",
    "($exists($tenant.assistant.M.composioMcpUrl.S) ? 'Your tools reach the business systems the owner connected (CRM, email): search for the right tool, then run it; do not stop at search results. CRM phone numbers are stored in E.164 form such as +15095551234, so search the phone property with that exact format. ' : '')",
    "'This is a chat: be brief and plain, no markdown. Use your tools to look things up or record things; say what you did and what you found. Never invent records. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 3000 characters.'",
  ].join(' & ');

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
      // handoff (workflows/browser-login.ts), not the assistant. The command
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
        Choices: [{ Condition: q('$exists($tenant) and $tenant.assistant.M.enabled.BOOL = true and $exists($tenant.assistant.M.composioMcpUrl.S)'), Next: 'Invoke' }],
        Default: 'Ignored',
      },
      Invoke: {
        Type: 'Task', Resource: 'arn:aws:states:::bedrockagentcore:invokeHarness',
        Arguments: {
          HarnessArn: refs.harnessArn,
          // One session per chat PER DAY: the day rolls at 3 AM tenant-local
          // (sessionDayOffsetMinutes, computed by the seed; 600 = Pacific if
          // unset). A new day is a fresh session; Memory carries the rest.
          // Ids must be >= 33 chars. One actor per person, tenant-prefixed.
          RuntimeSessionId: q("'telegram-chat-' & $string($states.input.message.chat.id) & '-' & $fromMillis($millis() - ($exists($tenant.sessionDayOffsetMinutes.N) ? $number($tenant.sessionDayOffsetMinutes.N) : 600) * 60000, '[Y0001][M01][D01]') & '-000000000000'"),
          ActorId: q("$tenant.tenantId.S & '_telegram_' & $string($states.input.message.from.id)"),
          Messages: [{ Role: 'user', Content: [{ Text: q('$states.input.message.text') }] }],
          SystemPrompt: [{ Text: q(prompt) }],
          // The tenant's SaaS tools: its Composio meta-tools session. The row
          // selects it; the key rides by ARN and is resolved from the vault at
          // invocation. Nothing the model or the caller sends can pick another.
          Tools: [{ Type: 'remote_mcp', Name: 'crm', Config: { RemoteMcp: { Url: q('$tenant.assistant.M.composioMcpUrl.S'), Headers: { 'x-api-key': `\${${refs.composioProviderArn}}` } } } }],
          AllowedTools: ['@crm/*'],
          TimeoutSeconds: 120,
        },
        Retry: [{ ErrorEquals: ['BedrockAgentCore.ThrottlingException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
        Assign: { reply: q('$states.result.Output.Message.Content[0].Text'), usage: q('$states.result.Usage') },
        Output: q('$states.input'), Next: 'Reply',
      },
      Reply: {
        Type: 'Task', Resource: 'arn:aws:states:::events:putEvents',
        Arguments: { Entries: [{
          EventBusName: refs.busName, Source: 'wnkinc.assistant', DetailType: 'telegram.reply',
          Detail: q("$string({'tenantId': $tenant.tenantId.S, 'chatId': $states.input.message.chat.id, 'text': $reply})"),
        }] },
        Output: q('$states.input'), Next: 'Usage',
      },
      Usage: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
        Arguments: { TableName: refs.usageTable, Item: {
          tenantId: { S: q('$tenant.tenantId.S') },
          sk: { S: q("$now() & '#llm_tokens#' & $uuid()") },
          meter: { S: 'llm_tokens' },
          units: { N: q('$string($usage.TotalTokens)') },
          ref: { S: q("'telegram:' & $string($states.input.message.chat.id)") },
        } },
        End: true,
      },
    },
  };
}
