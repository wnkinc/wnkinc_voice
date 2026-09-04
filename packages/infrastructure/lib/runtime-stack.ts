import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpStepFunctionsIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { dlqAlarm, errorAlarm, failedExecutionsAlarm } from './alarms.js';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly openaiSecret: secretsmanager.ISecret;
  /** Identity API key provider holding the OpenAI key; the assistant harness reads the key from the vault. */
  readonly openaiProviderArn: string;
  /** Identity API key provider holding the Composio key; the harness resolves it into the MCP session header. */
  readonly composioProviderArn: string;
  /** Composio API key (voice stack owns it; the tools Lambda reads it too). */
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
  /** Caller memory: the email agent recalls facts about the lead's caller. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The platform's agents: the email responder (a Lambda on the lead.recorded
 * rule) and My Assistant (an AgentCore harness driven by Step Functions).
 */
export class RuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // ---- Email responder: lead.recorded -> Lambda ------------------------------
    //
    // A failed invocation is retried by Lambda, then parked in the dead-letter
    // queue; the alarm on that queue is how a lost lead email gets noticed.
    const responderDlq = new sqs.Queue(this, 'EmailTriggerDlq', { retentionPeriod: cdk.Duration.days(14) });
    const responder = new NodejsFunction(this, 'EmailResponderFn', {
      functionName: `${prefix}-email-responder`,
      description: 'Drafts and sends the owner a follow-up email for each recorded lead',
      entry: path.resolve(here, '../../email-responder/src/responder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: responderDlq,
      bundling: { format: OutputFormat.ESM, target: 'node22', banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      environment: {
        OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
        USAGE_TABLE: props.usageTable.tableName,
        TENANTS_TABLE: props.tenantsTable.tableName,
        CALLS_TABLE: props.callsTable.tableName,
        COMPOSIO_SECRET_ARN: props.composioSecret.secretArn,
        ...(props.callerMemory ? { MEMORY_ID: props.callerMemory.memoryId } : {}),
      },
    });
    // Exactly what it touches: the tenant row, once-markers on the call row,
    // usage, the two platform secrets, and caller memory. No Gateway: it is an
    // automation, so the code is the policy and Composio scopes by tenant id.
    props.tenantsTable.grantReadData(responder);
    props.callsTable.grantReadWriteData(responder);
    props.usageTable.grantWriteData(responder);
    props.openaiSecret.grantRead(responder);
    props.composioSecret.grantRead(responder);
    if (props.callerMemory) {
      responder.addToRolePolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }
    new events.Rule(this, 'LeadRule', {
      eventBus: props.bus,
      description: 'Route lead.recorded to the email responder',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['lead.recorded'] },
      targets: [new targets.LambdaFunction(responder, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: responderDlq })],
    });
    dlqAlarm(this, 'EmailTriggerDlqAlarm', responderDlq, props.alarmTopic, 'Email responder: a lead email was not sent after retries');
    errorAlarm(this, 'EmailTriggerErrors', responder, props.alarmTopic, 'Email responder');

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

    new cdk.CfnOutput(this, 'assistantHarnessArn', { value: harness.attrArn });
    new cdk.CfnOutput(this, 'telegramSecretArn', { value: telegramSecret.secretArn });
    new cdk.CfnOutput(this, 'telegramWorkflowArn', { value: workflow.stateMachineArn });
    new cdk.CfnOutput(this, 'emailResponderFunctionName', { value: responder.functionName });
  }
}
