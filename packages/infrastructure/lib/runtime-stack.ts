import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpStepFunctionsIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { dlqAlarm, failedExecutionsAlarm } from './alarms.js';
import { Construct } from 'constructs';

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Identity API key provider holding the OpenAI key; the assistant harness reads the key from the vault. */
  readonly openaiProviderArn: string;
  /** Identity API key provider holding the Composio key; the harness resolves it into the MCP session header. */
  readonly composioProviderArn: string;
  /** Composio API key (voice stack owns it); the lead email workflow's HTTP tasks carry it through an EventBridge Connection. */
  readonly composioSecret: secretsmanager.ISecret;
  readonly bus: events.IEventBus;
  readonly usageTable: dynamodb.ITable;
  /** Agents read their tenant's row to check the service is enabled and how it is configured. */
  readonly tenantsTable: dynamodb.ITable;
  /** Once-markers for "already emailed this lead" live on the call row. */
  readonly callsTable: dynamodb.ITable;
  /** Channel identity -> tenant + person; the Telegram workflow's one lookup. */
  readonly peopleTable: dynamodb.ITable;
  /** The platform HTTP API; the Telegram webhook route is added here. */
  readonly api: apigwv2.IHttpApi;
  readonly alarmTopic: sns.ITopic;
  /** Platform memory: the harness threads sessions and retrieves facts from it. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The platform's agent, My Assistant (an AgentCore harness driven by the
 * Telegram workflow), and the two deterministic workflows on bus events:
 * the lead email and the owner alert. No code in this stack.
 */
export class RuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // ---- My Assistant: Telegram -> API Gateway -> Step Functions -> harness --
    //
    // No code on this path. The assistant is an AgentCore HARNESS: model,
    // default prompt, memory, and limits are configuration below. Per
    // invocation the workflow passes the message, a prompt built from the
    // tenant row, and the tenant's Composio MCP session (its URL on the row,
    // bound to the owner's connected accounts), so the only SaaS the model can
    // reach is that tenant's. The reply leaves through an EventBridge API destination
    // (Telegram wants the bot token in the URL path, which no managed HTTP
    // target can inject — but a destination's endpoint can carry it).

    // Bot token (set by hand, see README) plus a generated secret path segment
    // for the webhook URL — Telegram's recommended way to authenticate posts.
    const telegramSecret = new secretsmanager.Secret(this, 'TelegramSecret', {
      description: 'Telegram bot: {"TELEGRAM_BOT_TOKEN": <from BotFather>, "WEBHOOK_PATH": <generated>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TELEGRAM_BOT_TOKEN: 'set-me' }),
        generateStringKey: 'WEBHOOK_PATH',
        excludePunctuation: true,
        passwordLength: 40,
      },
    });

    const agentcoreArn = (resource: string) => `arn:aws:bedrock-agentcore:${this.region}:${this.account}:${resource}`;

    // The harness's execution role: the documented sample, scoped to what it
    // touches — the OpenAI and Composio key providers and the platform Memory
    // instance.
    const harnessRole = new iam.Role(this, 'AssistantHarnessRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the My Assistant harness',
    });
    harnessRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets',
        'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups', 'logs:PutResourcePolicy'],
      resources: ['*'],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetResourceApiKey'],
      resources: [
        agentcoreArn('workload-identity-directory/default'),
        agentcoreArn('workload-identity-directory/default/workload-identity/*'),
        agentcoreArn('token-vault/default'),
        props.openaiProviderArn,
        props.composioProviderArn,
      ],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!*`],
    }));
    if (props.callerMemory) {
      harnessRole.addToPolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }

    const harness = new agentcore.CfnHarness(this, 'AssistantHarness', {
      harnessName: `${prefix.replace(/-/g, '_')}_assistant`,
      executionRoleArn: harnessRole.roleArn,
      model: { openAiModelConfig: { modelId: process.env.ASSISTANT_MODEL ?? 'gpt-5.5', apiKeyArn: props.openaiProviderArn, apiFormat: 'responses', maxTokens: 1200 } },
      systemPrompt: [{ text: 'You are My Assistant for a small business. Be brief and plain. The per-invocation prompt names the business and the person.' }],
      // No default tools: the workflow passes the TENANT's Composio MCP
      // session per invocation. Never the built-in shell/file tools.
      allowedTools: ['@crm/*'],
      // Attached platform Memory: the harness threads each session's history
      // from it (surviving microVM expiry) and, per turn, retrieves what is
      // relevant from every strategy across ALL of the actor's sessions —
      // facts, preferences, and prior sessions' summaries via the parent path.
      memory: props.callerMemory ? { agentCoreMemoryConfiguration: {
        arn: props.callerMemory.memoryArn,
        messagesCount: 40,
        retrievalConfig: {
          '/callers/{actorId}/facts': { topK: 6, relevanceScore: 0.2 },
          '/callers/{actorId}/preferences': { topK: 4, relevanceScore: 0.2 },
          '/callers/{actorId}/summaries/': { topK: 3, relevanceScore: 0.2 },
        },
      } } : { disabled: {} },
      // Nothing is lost when the microVM goes (history is in Memory), so keep
      // idle time — and its memory billing — short.
      environment: { agentCoreRuntimeEnvironment: { lifecycleConfiguration: { idleRuntimeSessionTimeout: 300 } } },
      maxIterations: 8,
      timeoutSeconds: 120,
    });
    harness.node.addDependency(harnessRole);

    // ---- Reply path: EventBridge -> API destination -> Bot API sendMessage ----
    // The destination's endpoint carries the bot token, resolved from the
    // secret at deploy (same trick as the webhook route). Telegram ignores the
    // connection's dummy header. A rejected message (e.g. over 4096 chars)
    // lands in the DLQ and alarms.
    const connection = new events.Connection(this, 'TelegramConnection', {
      description: 'Telegram Bot API (auth is in the URL path; header is a placeholder)',
      authorization: events.Authorization.apiKey('x-wnk-connection', cdk.SecretValue.unsafePlainText('none')),
    });
    const telegramSend = new events.ApiDestination(this, 'TelegramSend', {
      connection,
      endpoint: `https://api.telegram.org/bot${telegramSecret.secretValueFromJson('TELEGRAM_BOT_TOKEN').unsafeUnwrap()}/sendMessage`,
      httpMethod: events.HttpMethod.POST,
      rateLimitPerSecond: 20,
    });
    const replyDlq = new sqs.Queue(this, 'TelegramReplyDlq', { retentionPeriod: cdk.Duration.days(14) });
    new events.Rule(this, 'TelegramReplyRule', {
      eventBus: props.bus,
      description: 'Deliver assistant replies to Telegram',
      eventPattern: { source: ['wnkinc.assistant'], detailType: ['telegram.reply'] },
      targets: [new targets.ApiDestination(telegramSend, {
        event: events.RuleTargetInput.fromObject({ chat_id: events.EventField.fromPath('$.detail.chatId'), text: events.EventField.fromPath('$.detail.text') }),
        deadLetterQueue: replyDlq,
        retryAttempts: 3,
        maxEventAge: cdk.Duration.minutes(10),
      })],
    });
    dlqAlarm(this, 'TelegramReplyDlqAlarm', replyDlq, props.alarmTopic, 'Assistant (Telegram): a reply was not delivered');

    // ---- The workflow (JSONata). Input is Telegram's Update object. -----------
    const q = (expr: string) => `{% ${expr} %}`;
    const prompt = [
      "'You are My Assistant for ' & $tenant.businessName.S & ', chatting with ' & $person.name.S & ' (' & $person.role.S & ') who works there. '",
      "($exists($tenant.description.S) ? 'About the business: ' & $tenant.description.S & ' ' : '')",
      "($exists($tenant.services.L) and $count($tenant.services.L) > 0 ? 'Services: ' & $join($tenant.services.L.S, ', ') & '. ' : '')",
      "($exists($tenant.hours.S) ? 'Hours: ' & $tenant.hours.S & '. ' : '')",
      "($exists($tenant.composioMcpUrl.S) ? 'Your tools reach the business systems the owner connected (CRM, email): search for the right tool, then run it; do not stop at search results. CRM phone numbers are stored in E.164 form such as +15095551234, so search the phone property with that exact format. ' : '')",
      "'This is a chat: be brief and plain, no markdown. Use your tools to look things up or record things; say what you did and what you found. Never invent records. If a request needs a tool you do not have, say so in one sentence. When they tell you something about the business or how they like things done, acknowledge it briefly; it is remembered. Keep replies under 3000 characters.'",
    ].join(' & ');
    const definition = {
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
          Arguments: { TableName: props.peopleTable.tableName, Key: { channelId: { S: q("'telegram:' & $string($states.input.message.from.id)") } } },
          Assign: { person: q('$states.result.Item') }, Output: q('$states.input'), Next: 'KnownSender',
        },
        KnownSender: { Type: 'Choice', Choices: [{ Condition: q('$exists($person)'), Next: 'LookupTenant' }], Default: 'UnknownSender' },
        UnknownSender: { Type: 'Succeed' },
        LookupTenant: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
          Arguments: { TableName: props.tenantsTable.tableName, Key: { phoneNumber: { S: q('$person.tenantPhone.S') } } },
          Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'AssistantEnabled',
        },
        AssistantEnabled: {
          Type: 'Choice',
          Choices: [{ Condition: q('$exists($tenant) and $tenant.products.M.assistant.M.enabled.BOOL = true and $exists($tenant.composioMcpUrl.S)'), Next: 'Invoke' }],
          Default: 'Ignored',
        },
        Invoke: {
          Type: 'Task', Resource: 'arn:aws:states:::bedrockagentcore:invokeHarness',
          Arguments: {
            HarnessArn: harness.attrArn,
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
            Tools: [{ Type: 'remote_mcp', Name: 'crm', Config: { RemoteMcp: { Url: q('$tenant.composioMcpUrl.S'), Headers: { 'x-api-key': `\${${props.composioProviderArn}}` } } } }],
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
            EventBusName: props.bus.eventBusName, Source: 'wnkinc.assistant', DetailType: 'telegram.reply',
            Detail: q("$string({'tenantId': $tenant.tenantId.S, 'chatId': $states.input.message.chat.id, 'text': $reply})"),
          }] },
          Output: q('$states.input'), Next: 'Usage',
        },
        Usage: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
          Arguments: { TableName: props.usageTable.tableName, Item: {
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
    const workflow = new sfn.StateMachine(this, 'TelegramWorkflow', {
      stateMachineName: `${prefix}-telegram`,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(definition)),
      timeout: cdk.Duration.minutes(5),
    });
    props.peopleTable.grantReadData(workflow);
    props.tenantsTable.grantReadData(workflow);
    props.usageTable.grantWriteData(workflow);
    props.bus.grantPutEventsTo(workflow);
    workflow.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
      resources: [harness.attrArn, `${harness.attrArn}/*`],
    }));
    failedExecutionsAlarm(this, 'TelegramWorkflowFailed', workflow, props.alarmTopic, 'Assistant (Telegram)');

    // Telegram posts here; API Gateway starts an execution and answers 200 at
    // once (Telegram retries anything slow). The path segment is the secret.
    new apigwv2.HttpRoute(this, 'TelegramRoute', {
      httpApi: props.api,
      routeKey: apigwv2.HttpRouteKey.with(`/telegram/${telegramSecret.secretValueFromJson('WEBHOOK_PATH').unsafeUnwrap()}`, apigwv2.HttpMethod.POST),
      integration: new HttpStepFunctionsIntegration('TelegramWebhook', {
        stateMachine: workflow,
        subtype: apigwv2.HttpIntegrationSubtype.STEPFUNCTIONS_START_EXECUTION,
        // A custom mapping replaces the construct's default one, so the state
        // machine ARN must be restated alongside the body-as-input mapping.
        parameterMapping: new apigwv2.ParameterMapping().custom('StateMachineArn', workflow.stateMachineArn).custom('Input', '$request.body'),
      }),
    });

    // ---- Lead email: lead.recorded -> Step Functions -> Composio HTTP -> Gmail --
    //
    // Deterministic, no model. The rule starts a workflow that reads the tenant
    // row, checks the flag and the once-marker, fetches what already exists
    // (the CRM contact and its last note through Composio, caller memory), and
    // formats the owner's email from those fields. Every Composio call is a
    // plain HTTP task naming the tenant as Composio's user_id; the API key
    // rides in an EventBridge Connection. Enrichment is best effort (Catch ->
    // continue); the profile lookup and the send fail the execution, which
    // alarms. The once-marker is written after the send: hardening against
    // redelivery, not exactly-once. One retry per Composio call, as the adapter
    // did. Toolkit versions are not pinned here (dev); pin in prod with a
    // `version` field on the execute bodies.
    const composioConnection = new events.Connection(this, 'ComposioConnection', {
      description: 'Composio API key for the lead email workflow',
      authorization: events.Authorization.apiKey('x-api-key', props.composioSecret.secretValueFromJson('COMPOSIO_API_KEY')),
    });
    // v3.1: the path the SDK uses; v3 does not resolve every HubSpot slug.
    const composio = (path: string) => `https://backend.composio.dev/api/v3.1/${path}`;
    const http = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query?: Record<string, string>) => ({
      Type: 'Task', Resource: 'arn:aws:states:::http:invoke',
      Arguments: {
        ApiEndpoint: composio(path), Method: method,
        Authentication: { ConnectionArn: composioConnection.connectionArn },
        ...(body ? { RequestBody: body } : {}), ...(query ? { QueryParameters: query } : {}),
      },
      Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 2, MaxAttempts: 1 }],
    });
    // Express with execution data NOT logged: for workflows that handle
    // transcripts or CRM notes. State transitions and errors still log (and the
    // failed-executions alarm still fires); payloads are persisted nowhere.
    const expressNoData = (logId: string) => ({
      stateMachineType: sfn.StateMachineType.EXPRESS,
      logs: {
        destination: new logs.LogGroup(this, logId, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
        level: sfn.LogLevel.ALL,
        includeExecutionData: false,
      },
    });
    // HTTP tasks: the endpoint allow-list, the connection, and the secret EventBridge keeps for it.
    const grantComposioHttp = (wf: sfn.StateMachine) => {
      wf.addToRolePolicy(new iam.PolicyStatement({
        actions: ['states:InvokeHTTPEndpoint'], resources: ['*'],
        conditions: { StringLike: { 'states:HTTPEndpoint': [composio('*')] } },
      }));
      wf.addToRolePolicy(new iam.PolicyStatement({ actions: ['events:RetrieveConnectionCredentials'], resources: [composioConnection.connectionArn] }));
      wf.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:events!connection/*`],
      }));
    };
    // A start a rule could not deliver (after retries) parks here and alarms;
    // an execution that started and failed alarms through the workflow metric.
    const startDlq = new sqs.Queue(this, 'LeadEmailDlq', { retentionPeriod: cdk.Duration.days(14) });
    const onceKey = q("'done:email:lead:' & $states.input.detail.lead.leadId");
    const tenantId = q('$tenant.tenantId.S');
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
      "'\\nCRM: ' & ($exists($contact) ? 'known contact ' & $join([$contact.properties.firstname, $contact.properties.lastname], ' ') & ' ' & $contact.url"
        + ` & ($exists($note.hs_note_body) ? '\\nLast note (' & $substring($note.hs_createdate, 0, 10) & '):\\n' & ${noteText} : '\\nNo notes on this contact yet.')`
        + " : 'no matching contact.') & '\\n'",
      // Preference records arrive as JSON text; show their preference sentence, not the blob.
      "($count($memories) > 0 ? '\\nCaller preferences (from earlier calls):\\n' & $join($memories.('- ' & ($substring($, 0, 1) = '{' ? $match($, /\"preference\":\"([^\"]*)\"/)[0].groups[0] : $)), '\\n') & '\\n' : '')",
      `'\\nSuggested text: Hi ' & $split(${lead}.callerName, ' ')[0] & ', this is ' & $tenant.businessName.S & '. Thanks for calling about ' & ${lead}.reason & '. When is a good time to talk? Reply here or call ' & $tenant.phoneNumber.S & '.\\n'`,
      "'\\nCall ' & $states.input.detail.callId",
    ].join(' & ');
    const leadDefinition = {
      QueryLanguage: 'JSONata',
      StartAt: 'LookupTenant',
      States: {
        LookupTenant: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
          Arguments: { TableName: props.tenantsTable.tableName, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
          Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'ResponderEnabled',
        },
        ResponderEnabled: {
          Type: 'Choice',
          Choices: [{ Condition: q('$exists($tenant) and $tenant.products.M.emailResponder.M.enabled.BOOL = true'), Next: 'CheckDone' }],
          Default: 'Skipped',
        },
        Skipped: { Type: 'Succeed' },
        CheckDone: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
          Arguments: {
            TableName: props.callsTable.tableName, Key: { callId: { S: q('$states.input.detail.callId') } },
            ProjectionExpression: '#k', ExpressionAttributeNames: { '#k': onceKey },
          },
          Assign: { done: q('$exists($states.result.Item) and $count($keys($states.result.Item)) > 0') }, Output: q('$states.input'), Next: 'AlreadyEmailed',
        },
        AlreadyEmailed: { Type: 'Choice', Choices: [{ Condition: q('$done'), Next: 'Skipped' }], Default: 'HasCrm' },
        // ---- Enrichment: the tenant's CRM (by its row), best effort ----------
        HasCrm: {
          Type: 'Choice',
          Choices: [{ Condition: q(`$exists(${lead}.phone) and $tenant.crm.M.type.S = 'hubspot' and $tenant.crm.M.via.S = 'composio'`), Next: 'FindContact' }],
          Default: 'HasPhone',
        },
        FindContact: {
          ...http('POST', 'tools/execute/HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
            user_id: tenantId,
            arguments: { filterGroups: [phoneFilter('phone'), phoneFilter('mobilephone')], properties: ['firstname', 'lastname', 'phone', 'email'], limit: 1 },
          }),
          Assign: { contact: q('$states.result.ResponseBody.data.results[0]') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasPhone' }],
          Output: q('$states.input'), Next: 'HasContact',
        },
        HasContact: { Type: 'Choice', Choices: [{ Condition: q('$exists($contact.id)'), Next: 'HubspotAccount' }], Default: 'HasPhone' },
        // Notes have no Composio tool; the proxy needs the connected account id.
        HubspotAccount: {
          ...http('GET', 'connected_accounts', undefined, { user_ids: tenantId, toolkit_slugs: 'hubspot', statuses: 'ACTIVE' }),
          Assign: { accountId: q('$states.result.ResponseBody.items[0].id') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasPhone' }],
          Output: q('$states.input'), Next: 'LastNote',
        },
        LastNote: {
          ...http('POST', 'tools/execute/proxy', {
            endpoint: '/crm/v3/objects/notes/search', method: 'POST', connected_account_id: q('$accountId'),
            body: {
              filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: q('$contact.id') }] }],
              sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
              properties: ['hs_note_body', 'hs_timestamp'], limit: 1,
            },
          }),
          Assign: { note: q('$states.result.ResponseBody.data.results[0].properties') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasPhone' }],
          Output: q('$states.input'), Next: 'HasPhone',
        },
        // ---- Enrichment: caller preferences from memory, best effort -----------
        HasPhone: { Type: 'Choice', Choices: [{ Condition: q(`$exists(${lead}.phone)`), Next: props.callerMemory ? 'RecallMemory' : 'OwnerEmail' }], Default: 'OwnerEmail' },
        ...(props.callerMemory ? { RecallMemory: {
          Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:retrieveMemoryRecords',
          Arguments: {
            MemoryId: props.callerMemory.memoryId,
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
          ...http('POST', 'tools/execute/GMAIL_GET_PROFILE', { user_id: tenantId, arguments: {} }),
          Assign: { ownerEmail: q('$states.result.ResponseBody.data.emailAddress') },
          Output: q('$states.input'), Next: 'HasOwnerEmail',
        },
        HasOwnerEmail: { Type: 'Choice', Choices: [{ Condition: q('$exists($ownerEmail)'), Next: 'Send' }], Default: 'NoGmail' },
        NoGmail: { Type: 'Fail', Error: 'NoGmailConnection', Cause: 'No Gmail profile for the tenant in Composio; run scripts/connect-composio.mts <tenantId> gmail' },
        Send: {
          ...http('POST', 'tools/execute/GMAIL_SEND_EMAIL', {
            user_id: tenantId,
            arguments: {
              recipient_email: q('$ownerEmail'),
              subject: q(`'New lead: ' & ${lead}.callerName & ' - ' & $substring(${lead}.reason, 0, 60)`),
              body: q(bodyExpr),
            },
          }),
          Assign: { sent: q('$states.result.ResponseBody.successful = true') },
          Output: q('$states.input'), Next: 'SentOk',
        },
        SentOk: { Type: 'Choice', Choices: [{ Condition: q('$sent'), Next: 'MarkDone' }], Default: 'SendRejected' },
        SendRejected: { Type: 'Fail', Error: 'SendRejected', Cause: 'Composio answered 200 but successful=false for GMAIL_SEND_EMAIL; see the execution history' },
        MarkDone: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
          Arguments: {
            TableName: props.callsTable.tableName, Key: { callId: { S: q('$states.input.detail.callId') } },
            UpdateExpression: 'SET #k = :at, expiresAt = if_not_exists(expiresAt, :ttl)',
            ConditionExpression: 'attribute_not_exists(#k)',
            ExpressionAttributeNames: { '#k': onceKey },
            ExpressionAttributeValues: { ':at': { S: q('$now()') }, ':ttl': { N: q('$string($floor($millis() / 1000) + 90 * 86400)') } },
          },
          // Marked meanwhile by a concurrent delivery: the email went out either way, so still meter it.
          Catch: [{ ErrorEquals: ['DynamoDB.ConditionalCheckFailedException'], Output: q('$states.input'), Next: 'UsageEmail' }],
          Output: q('$states.input'), Next: 'UsageEmail',
        },
        UsageEmail: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
          Arguments: { TableName: props.usageTable.tableName, Item: {
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
    // Express, no execution data: the email body carries the CRM note. (Named
    // -express because Standard -> Express is a replacement, and CloudFormation
    // creates the new machine before deleting the old one of the same name.)
    const leadWorkflow = new sfn.StateMachine(this, 'LeadEmailWorkflow', {
      stateMachineName: `${prefix}-lead-email-express`,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(leadDefinition)),
      timeout: cdk.Duration.minutes(5),
      ...expressNoData('LeadEmailWorkflowLogs'),
    });
    props.tenantsTable.grantReadData(leadWorkflow);
    props.callsTable.grantReadWriteData(leadWorkflow);
    props.usageTable.grantWriteData(leadWorkflow);
    grantComposioHttp(leadWorkflow);
    if (props.callerMemory) {
      leadWorkflow.addToRolePolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }
    new events.Rule(this, 'LeadRule', {
      eventBus: props.bus,
      description: 'Route lead.recorded to the lead email workflow',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['lead.recorded'] },
      targets: [new targets.SfnStateMachine(leadWorkflow, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    failedExecutionsAlarm(this, 'LeadEmailWorkflowFailed', leadWorkflow, props.alarmTopic, 'Lead email');

    // ---- CRM sync: lead.recorded / call.ended -> Step Functions -> HubSpot ----
    //
    // Deterministic, no code. The lead workflow (Standard: its input is the
    // lead fields, which the owner's email carries anyway) upserts the contact,
    // adds a note, and adds a follow-up task due the next business morning.
    // The call workflow (Express, execution data not logged: it handles the
    // transcript) adds a transcript note when the caller is already a contact.
    // The transcript never rides on the bus; the workflow reads it from the
    // call row by id. Once-marker before, mark after; a failed execution
    // alarms, as the Lambda's DLQ did.
    const esc = (expr: string) => `$replace($replace($replace(${expr}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;
    const crmOn = (phoneExpr: string) => q(`$exists(${phoneExpr}) and $tenant.crm.M.type.S = 'hubspot' and $tenant.crm.M.via.S = 'composio'`);
    const findContact = (phoneExpr: string, next: string) => ({
      ...http('POST', 'tools/execute/HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
        user_id: tenantId,
        arguments: {
          filterGroups: [
            { filters: [{ propertyName: 'phone', operator: 'EQ', value: q(phoneExpr) }] },
            { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: q(phoneExpr) }] },
          ],
          properties: ['firstname', 'lastname', 'phone'], limit: 1,
        },
      }),
      Assign: { contact: q('$states.result.ResponseBody.data.results[0]') },
      Output: q('$states.input'), Next: next,
    });
    const assoc = (typeId: number) => [{ to: { id: q('$contactId') }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] }];
    const markDone = (key: string) => ({
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
      Arguments: {
        TableName: props.callsTable.tableName, Key: { callId: { S: q('$states.input.detail.callId') } },
        UpdateExpression: 'SET #k = :at, expiresAt = if_not_exists(expiresAt, :ttl)',
        ExpressionAttributeNames: { '#k': key },
        ExpressionAttributeValues: { ':at': { S: q('$now()') }, ':ttl': { N: q('$string($floor($millis() / 1000) + 90 * 86400)') } },
      },
      End: true,
    });
    const checkDone = (key: string, extraProjection = '') => ({
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
      Arguments: {
        TableName: props.callsTable.tableName, Key: { callId: { S: q('$states.input.detail.callId') } },
        ProjectionExpression: `#k${extraProjection ? `, ${extraProjection}` : ''}`, ExpressionAttributeNames: { '#k': key },
      },
    });
    // Next weekday at 9:00 tenant-local, from the zone offset the seed derives
    // (sessionDayOffsetMinutes = 180 - zoneOffsetMinutes). JSONata has no tz
    // database, so after a DST change the hour drifts by one until the next seed.
    const nextBusinessMorning = [
      "( $zone := (180 - ($exists($tenant.sessionDayOffsetMinutes.N) ? $number($tenant.sessionDayOffsetMinutes.N) : 600)) * 60000;",
      '$nowMs := $millis(); $day := $floor(($nowMs + $zone) / 86400000);',
      '$due := [0..7] ~> $map(function($i) { ( $d := $day + $i; $dow := ($d + 4) % 7; ($dow != 0 and $dow != 6) ? ($d * 86400000 + 9 * 3600000 - $zone) : 0 ) }) ~> $filter(function($t) { $t > $nowMs });',
      '$fromMillis($due[0]) )',
    ].join(' ');
    const crmLeadKey = q("'done:crm:lead:' & $states.input.detail.lead.leadId");
    const crmLeadDefinition = {
      QueryLanguage: 'JSONata',
      StartAt: 'CheckDone',
      States: {
        CheckDone: {
          ...checkDone(crmLeadKey),
          Assign: { done: q('$exists($states.result.Item) and $count($keys($states.result.Item)) > 0') }, Output: q('$states.input'), Next: 'AlreadyDone',
        },
        AlreadyDone: { Type: 'Choice', Choices: [{ Condition: q('$done'), Next: 'Skipped' }], Default: 'LookupTenant' },
        Skipped: { Type: 'Succeed' },
        LookupTenant: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
          Arguments: { TableName: props.tenantsTable.tableName, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
          Assign: {
            tenant: q('$states.result.Item'),
            name: q(`$trim(${lead}.callerName)`),
            first: q(`$split($trim(${lead}.callerName), ' ')[0]`),
            last: q(`$trim($substringAfter($trim(${lead}.callerName), ' '))`),
          },
          Output: q('$states.input'), Next: 'HasCrm',
        },
        HasCrm: { Type: 'Choice', Choices: [{ Condition: crmOn(`${lead}.phone`), Next: 'FindContact' }], Default: 'Skipped' },
        FindContact: findContact(`${lead}.phone`, 'HasContact'),
        HasContact: { Type: 'Choice', Choices: [{ Condition: q('$exists($contact.id)'), Next: 'MissingNames' }], Default: 'CreateContact' },
        CreateContact: {
          ...http('POST', 'tools/execute/HUBSPOT_CREATE_CONTACT', {
            user_id: tenantId,
            arguments: q(`$merge([{'phone': ${lead}.phone}, ($first != '' ? {'firstname': $first} : {}), ($last != '' ? {'lastname': $last} : {})])`),
          }),
          Assign: { contactId: q('$states.result.ResponseBody.data.id') },
          Output: q('$states.input'), Next: 'AddNote',
        },
        // An existing contact only gains the name fields it lacks.
        MissingNames: {
          Type: 'Pass',
          Assign: {
            contactId: q('$contact.id'),
            props: q("$merge([($first != '' and $not($exists($contact.properties.firstname)) ? {'firstname': $first} : {}), ($last != '' and $not($exists($contact.properties.lastname)) ? {'lastname': $last} : {})])"),
          },
          Output: q('$states.input'), Next: 'NeedsUpdate',
        },
        NeedsUpdate: { Type: 'Choice', Choices: [{ Condition: q('$count($keys($props)) > 0'), Next: 'UpdateContact' }], Default: 'AddNote' },
        UpdateContact: {
          ...http('POST', 'tools/execute/HUBSPOT_UPDATE_CONTACT', { user_id: tenantId, arguments: { contactId: q('$contactId'), properties: q('$props') } }),
          Output: q('$states.input'), Next: 'AddNote',
        },
        AddNote: {
          ...http('POST', 'tools/execute/HUBSPOT_CREATE_NOTE', {
            user_id: tenantId,
            arguments: {
              hs_timestamp: q('$now()'),
              hs_note_body: q([
                "'Phone lead via receptionist (' & $tenant.businessName.S & ' line)<br><br>'",
                `'Reason: ' & ${esc(`${lead}.reason`)} & '<br>'`,
                `($exists(${lead}.preferredCallbackTime) ? 'Preferred callback: ' & ${esc(`${lead}.preferredCallbackTime`)} & '<br>' : '')`,
                `($exists(${lead}.notes) ? 'Notes: ' & ${esc(`${lead}.notes`)} & '<br>' : '')`,
                "'<br>Call ID: ' & $states.input.detail.callId",
              ].join(' & ')),
              associations: assoc(202),
            },
          }),
          Output: q('$states.input'), Next: 'DefaultOwner',
        },
        // The account's first owner gets the task; no owner is not an error.
        DefaultOwner: {
          ...http('POST', 'tools/execute/HUBSPOT_RETRIEVE_OWNERS', { user_id: tenantId, arguments: { limit: 1 } }),
          Assign: { ownerId: q('$states.result.ResponseBody.data.results[0].id') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'AddTask' }],
          Output: q('$states.input'), Next: 'AddTask',
        },
        AddTask: {
          ...http('POST', 'tools/execute/HUBSPOT_CREATE_TASK', {
            user_id: tenantId,
            arguments: q([
              "$merge([{",
              `'hs_timestamp': ${nextBusinessMorning},`,
              `'hs_task_subject': 'Follow up with ' & $name & ' (' & ${lead}.phone & ')',`,
              `'hs_task_body': ${esc(`${lead}.reason`)} & ($exists(${lead}.preferredCallbackTime) ? '<br>Preferred: ' & ${esc(`${lead}.preferredCallbackTime`)} : ''),`,
              "'hs_task_status': 'NOT_STARTED', 'hs_task_priority': 'MEDIUM', 'hs_task_type': 'TODO',",
              `'associations': [{'to': {'id': $contactId}, 'types': [{'associationCategory': 'HUBSPOT_DEFINED', 'associationTypeId': 204}]}]`,
              "}, ($exists($ownerId) ? {'hubspot_owner_id': $ownerId} : {})])",
            ].join(' ')),
          }),
          Output: q('$states.input'), Next: 'MarkDone',
        },
        MarkDone: markDone(crmLeadKey),
      },
    };
    const crmLeadWorkflow = new sfn.StateMachine(this, 'CrmLeadWorkflow', {
      stateMachineName: `${prefix}-crm-lead`,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(crmLeadDefinition)),
      timeout: cdk.Duration.minutes(5),
    });

    const crmCallDefinition = {
      QueryLanguage: 'JSONata',
      StartAt: 'HasCaller',
      States: {
        HasCaller: { Type: 'Choice', Choices: [{ Condition: q("$exists($states.input.detail.callerPhone) and $states.input.detail.status = 'completed'"), Next: 'CheckDone' }], Default: 'Skipped' },
        Skipped: { Type: 'Succeed' },
        // One read: the marker and the transcript (kept off the bus; fetched by id here).
        CheckDone: {
          ...checkDone('done:crm:call', 'transcript'),
          Assign: { done: q("$exists($states.result.Item.`done:crm:call`)"), transcript: q('[$states.result.Item.transcript.L]') },
          Output: q('$states.input'), Next: 'AlreadyDone',
        },
        AlreadyDone: { Type: 'Choice', Choices: [{ Condition: q('$done or $count($transcript) = 0'), Next: 'Skipped' }], Default: 'LookupTenant' },
        LookupTenant: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
          Arguments: { TableName: props.tenantsTable.tableName, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
          Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'HasCrm',
        },
        HasCrm: { Type: 'Choice', Choices: [{ Condition: crmOn('$states.input.detail.callerPhone'), Next: 'FindContact' }], Default: 'Skipped' },
        FindContact: findContact('$states.input.detail.callerPhone', 'HasContact'),
        // Only callers already in the CRM get a transcript note.
        HasContact: { Type: 'Choice', Choices: [{ Condition: q('$exists($contact.id)'), Next: 'AddNote' }], Default: 'Skipped' },
        AddNote: {
          ...http('POST', 'tools/execute/HUBSPOT_CREATE_NOTE', {
            user_id: tenantId,
            arguments: {
              hs_timestamp: q('$now()'),
              hs_note_body: q([
                "$substring('Call to ' & $tenant.businessName.S & ' line - ' & $string($round($states.input.detail.durationSeconds / 60)) & ' min, ' & $states.input.detail.status & '<br><br>'",
                `& $join($transcript[M.role.S != 'tool'].((M.role.S = 'user' ? 'Caller: ' : 'Agent: ') & ${esc('M.text.S')}), '<br>')`,
                "& '<br><br>Call ID: ' & $states.input.detail.callId, 0, 60000)",
              ].join(' ')),
              associations: [{ to: { id: q('$contact.id') }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
            },
          }),
          Output: q('$states.input'), Next: 'MarkDone',
        },
        MarkDone: markDone('done:crm:call'),
      },
    };
    const crmCallWorkflow = new sfn.StateMachine(this, 'CrmCallWorkflow', {
      stateMachineName: `${prefix}-crm-call`,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(crmCallDefinition)),
      timeout: cdk.Duration.minutes(5),
      ...expressNoData('CrmCallWorkflowLogs'),
    });
    for (const wf of [crmLeadWorkflow, crmCallWorkflow]) {
      props.tenantsTable.grantReadData(wf);
      props.callsTable.grantReadWriteData(wf);
      grantComposioHttp(wf);
    }
    new events.Rule(this, 'CrmLeadRule', {
      eventBus: props.bus,
      description: 'Route lead.recorded to the CRM lead workflow',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['lead.recorded'] },
      targets: [new targets.SfnStateMachine(crmLeadWorkflow, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    new events.Rule(this, 'CrmCallRule', {
      eventBus: props.bus,
      description: 'Route call.ended to the CRM call workflow',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['call.ended'] },
      targets: [new targets.SfnStateMachine(crmCallWorkflow, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    failedExecutionsAlarm(this, 'CrmLeadWorkflowFailed', crmLeadWorkflow, props.alarmTopic, 'CRM sync (lead)');
    failedExecutionsAlarm(this, 'CrmCallWorkflowFailed', crmCallWorkflow, props.alarmTopic, 'CRM sync (call)');

    // ---- Owner alert: owner.notify -> Step Functions -> Telegram reply path ----
    //
    // The receptionist's notify_owner tool publishes owner.notify. This
    // workflow reads the tenant row, picks the owner with a Telegram id, and
    // publishes the same telegram.reply event the assistant uses; the reply rule
    // above delivers it. No once-marker: an alert delivered twice on a rare
    // redelivery is harmless, and it is neither money nor customer-facing. A
    // tenant with the tool on but no owner channel fails loudly (alarm).
    const alertDefinition = {
      QueryLanguage: 'JSONata',
      StartAt: 'LookupTenant',
      States: {
        LookupTenant: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
          Arguments: { TableName: props.tenantsTable.tableName, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
          Assign: {
            tenant: q('$states.result.Item'),
            chatId: q("$states.result.Item.people.L[M.role.S = 'owner' and $exists(M.telegramId.N)][0].M.telegramId.N"),
          },
          Output: q('$states.input'), Next: 'OwnerChannel',
        },
        OwnerChannel: { Type: 'Choice', Choices: [{ Condition: q('$exists($chatId)'), Next: 'Deliver' }], Default: 'NoOwnerChannel' },
        NoOwnerChannel: { Type: 'Fail', Error: 'NoOwnerChannel', Cause: 'The tenant has no owner with a Telegram id; add one under people and re-seed' },
        Deliver: {
          Type: 'Task', Resource: 'arn:aws:states:::events:putEvents',
          Arguments: { Entries: [{
            EventBusName: props.bus.eventBusName, Source: 'wnkinc.assistant', DetailType: 'telegram.reply',
            Detail: q([
              "$string({'tenantId': $tenant.tenantId.S, 'chatId': $number($chatId), 'text': ",
              "($states.input.detail.urgency = 'urgent' ? 'URGENT' : 'Heads up') & ' (' & $tenant.businessName.S & '): ' & $states.input.detail.summary",
              " & ($exists($states.input.detail.callerPhone) ? ' Caller: ' & $states.input.detail.callerPhone : '')})",
            ].join('')),
          }] },
          End: true,
        },
      },
    };
    const alertWorkflow = new sfn.StateMachine(this, 'OwnerAlertWorkflow', {
      stateMachineName: `${prefix}-owner-alert`,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(alertDefinition)),
      timeout: cdk.Duration.minutes(2),
    });
    props.tenantsTable.grantReadData(alertWorkflow);
    props.bus.grantPutEventsTo(alertWorkflow);
    new events.Rule(this, 'OwnerAlertRule', {
      eventBus: props.bus,
      description: 'Route owner.notify to the owner alert workflow',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['owner.notify'] },
      targets: [new targets.SfnStateMachine(alertWorkflow, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    failedExecutionsAlarm(this, 'OwnerAlertWorkflowFailed', alertWorkflow, props.alarmTopic, 'Owner alert');
    dlqAlarm(this, 'LeadEmailDlqAlarm', startDlq, props.alarmTopic, 'Workflows: a lead.recorded or owner.notify event could not start its workflow');

    new cdk.CfnOutput(this, 'assistantHarnessArn', { value: harness.attrArn });
    new cdk.CfnOutput(this, 'leadEmailWorkflowArn', { value: leadWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'ownerAlertWorkflowArn', { value: alertWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'crmLeadWorkflowArn', { value: crmLeadWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'crmCallWorkflowArn', { value: crmCallWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'telegramSecretArn', { value: telegramSecret.secretArn });
    new cdk.CfnOutput(this, 'telegramWorkflowArn', { value: workflow.stateMachineArn });
  }
}
