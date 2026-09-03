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
import { buildSync } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly gatewayUrl: string;
  readonly cognitoUserPoolId: string;
  readonly cognitoTokenUrl: string;
  readonly workloadName: string;
  readonly googleProviderName: string;
  readonly openaiSecret: secretsmanager.ISecret;
  /** Identity API key provider holding the OpenAI key; the assistant harness reads the key from the vault. */
  readonly openaiProviderArn: string;
  /** The Gateway the assistant harness attaches per invocation (as the tenant). */
  readonly gatewayId: string;
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
 * Agents hosted on AgentCore Runtime. The email responder is bundled with
 * esbuild (single index.mjs, no Docker) and runs on the managed NODE_22
 * runtime; an EventBridge rule + small trigger Lambda invoke it per lead.
 */
export class RuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // Bundle an agent at synth time, same pattern NodejsFunction uses for
    // Lambdas. CJS + .js: the managed NODE_22 runtime requires a .js entrypoint,
    // and CJS sidesteps type:module ambiguity; the package.json pins that, and
    // the banner shims import.meta.url (undefined under CJS) for deps.
    const bundleAgent = (name: string): string => {
      const dist = path.resolve(here, `../.build/${name}`);
      rmSync(dist, { recursive: true, force: true });
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'commonjs' }));
      buildSync({
        entryPoints: [path.resolve(here, `../../${name}/src/agent.ts`)],
        outfile: path.join(dist, 'index.js'),
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        sourcemap: false,
        logLevel: 'warning',
        define: { 'import.meta.url': '__importMetaUrl' },
        banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
      });
      return dist;
    };
    const dist = bundleAgent('email-responder');

    // Which broker a tenant's Gmail uses is tenant data: `products.emailResponder.via`.
    const composioSecret = props.composioSecret;

    const emailAgent = new agentcore.Runtime(this, 'EmailResponder', {
      runtimeName: `${prefix.replace(/-/g, '_')}_email_responder`,
      description: 'Drafts and sends the owner a follow-up email for each recorded lead',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: dist,
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ['index.js'], // managed NODE_22 runs the file itself; no interpreter prefix
      }),
      environmentVariables: {
        GATEWAY_URL: props.gatewayUrl,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        GATEWAY_SCOPE: 'gateway/email',
        COGNITO_TOKEN_URL: props.cognitoTokenUrl,
        WORKLOAD_NAME: props.workloadName,
        GOOGLE_PROVIDER_NAME: props.googleProviderName,
        OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
        USAGE_TABLE: props.usageTable.tableName,
        TENANTS_TABLE: props.tenantsTable.tableName,
        CALLS_TABLE: props.callsTable.tableName,
        COMPOSIO_SECRET_ARN: composioSecret.secretArn,
        ...(props.callerMemory ? { MEMORY_ID: props.callerMemory.memoryId } : {}),
      },
    });
    composioSecret.grantRead(emailAgent.role);
    props.tenantsTable.grantReadData(emailAgent.role);
    props.callsTable.grantReadWriteData(emailAgent.role);

    // The agent's own credentials: read the vault token for its workload, read
    // the OpenAI key, and read the Cognito client secret for Gateway JWTs.
    const agentcoreArn = (resource: string) => `arn:aws:bedrock-agentcore:${this.region}:${this.account}:${resource}`;
    emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessTokenForUserId', 'bedrock-agentcore:GetResourceOauth2Token'],
      resources: [
        agentcoreArn('workload-identity-directory/default'),
        agentcoreArn(`workload-identity-directory/default/workload-identity/${props.workloadName}`),
        agentcoreArn('token-vault/default'),
        agentcoreArn('token-vault/default/oauth2credentialprovider/*'),
      ],
    }));
    emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!*`],
    }));
    props.openaiSecret.grantRead(emailAgent.role);
    props.usageTable.grantWriteData(emailAgent.role);
    if (props.callerMemory) {
      emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }
    emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:DescribeUserPoolClient'],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`],
    }));

    // lead.recorded -> trigger Lambda -> InvokeAgentRuntime. The trigger throws
    // on an agent failure, so Lambda retries it twice and then parks the event
    // here; the alarm on this queue is how a lost lead email gets noticed.
    const triggerDlq = new sqs.Queue(this, 'EmailTriggerDlq', { retentionPeriod: cdk.Duration.days(14) });
    const triggerFn = new NodejsFunction(this, 'EmailTrigger', {
      functionName: `${prefix}-email-trigger`,
      description: 'Invokes the email responder runtime for each lead.recorded event',
      entry: path.resolve(here, '../../email-responder/src/trigger.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      environment: { EMAIL_AGENT_RUNTIME_ARN: emailAgent.agentRuntimeArn },
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: triggerDlq,
      bundling: { format: OutputFormat.ESM, target: 'node22' },
    });
    triggerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [emailAgent.agentRuntimeArn, `${emailAgent.agentRuntimeArn}/runtime-endpoint/*`],
    }));
    new events.Rule(this, 'LeadRule', {
      eventBus: props.bus,
      description: 'Route lead.recorded to the email responder agent',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['lead.recorded'] },
      targets: [new targets.LambdaFunction(triggerFn, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: triggerDlq })],
    });
    dlqAlarm(this, 'EmailTriggerDlqAlarm', triggerDlq, props.alarmTopic, 'Email responder: a lead email was not sent after retries');
    errorAlarm(this, 'EmailTriggerErrors', triggerFn, props.alarmTopic, 'Email responder trigger');

    // ---- Back-office agent: Runtime + AgentCore Browser -----------------------

    const browser = new agentcore.BrowserCustom(this, 'Browser', {
      browserCustomName: `${prefix.replace(/-/g, '_')}_browser`,
      description: 'Managed browser for back-office research tasks',
      networkConfiguration: agentcore.BrowserNetworkConfiguration.usingPublicNetwork(),
    });

    const backOffice = new agentcore.Runtime(this, 'BackOffice', {
      runtimeName: `${prefix.replace(/-/g, '_')}_back_office`,
      description: 'Research tasks: drives an AgentCore Browser session and answers questions from pages',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: bundleAgent('back-office'),
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ['index.js'],
      }),
      environmentVariables: {
        BROWSER_ID: browser.browserId,
        OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
        USAGE_TABLE: props.usageTable.tableName,
        TENANTS_TABLE: props.tenantsTable.tableName,
      },
    });
    browser.grantUse(backOffice.role);
    props.usageTable.grantWriteData(backOffice.role);
    props.tenantsTable.grantReadData(backOffice.role);
    // grantUse only grants Start/Stop/UpdateBrowserStream — the automation-stream
    // WebSocket needs ConnectBrowserAutomationStream, on both the browser ARN and
    // its session subresources.
    backOffice.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:GetBrowserSession'],
      resources: [browser.browserArn, `${browser.browserArn}/*`],
    }));
    props.openaiSecret.grantRead(backOffice.role);

    // ---- My Assistant: Telegram -> API Gateway -> Step Functions -> harness --
    //
    // No code on this path. The assistant is an AgentCore HARNESS: model,
    // default prompt, memory, and limits are configuration below. Per
    // invocation the workflow passes the message, a prompt built from the
    // tenant row, and the tenant's Gateway OAuth provider, so the harness calls
    // tools AS the tenant's own client and the Gateway interceptor attributes
    // every call. The reply leaves through an EventBridge API destination
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

    const gatewayArn = agentcoreArn(`gateway/${props.gatewayId}`);

    // The harness's execution role: the documented sample, scoped to what it
    // touches — the OpenAI key provider, ANY tenant's Gateway OAuth provider
    // (minted per tenant by the seed), and the platform Memory instance.
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
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetResourceApiKey', 'bedrock-agentcore:GetResourceOauth2Token'],
      resources: [
        agentcoreArn('workload-identity-directory/default'),
        agentcoreArn('workload-identity-directory/default/workload-identity/*'),
        agentcoreArn('token-vault/default'),
        props.openaiProviderArn,
        agentcoreArn('token-vault/default/oauth2credentialprovider/*'),
      ],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!*`],
    }));
    harnessRole.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:InvokeGateway'], resources: [gatewayArn] }));
    if (props.callerMemory) {
      harnessRole.addToPolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }

    const harness = new agentcore.CfnHarness(this, 'AssistantHarness', {
      harnessName: `${prefix.replace(/-/g, '_')}_assistant`,
      executionRoleArn: harnessRole.roleArn,
      model: { openAiModelConfig: { modelId: process.env.ASSISTANT_MODEL ?? 'gpt-5-mini', apiKeyArn: props.openaiProviderArn, apiFormat: 'responses', maxTokens: 1200 } },
      systemPrompt: [{ text: 'You are My Assistant for a small business. Be brief and plain. The per-invocation prompt names the business and the person.' }],
      // No default Gateway tool: the workflow passes the TENANT's provider per invocation.
      allowedTools: ['@wnkgateway/*'], // never the built-in shell/file tools
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
          Choices: [{ Condition: q('$exists($tenant) and $tenant.products.M.assistant.M.enabled.BOOL = true and $exists($tenant.gatewayOauthProviderArn.S)'), Next: 'Invoke' }],
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
            Tools: [{ Type: 'agentcore_gateway', Name: 'wnkgateway', Config: { AgentCoreGateway: { GatewayArn: gatewayArn, OutboundAuth: { Oauth: { ProviderArn: q('$tenant.gatewayOauthProviderArn.S'), Scopes: ['gateway/assistant'], GrantType: 'CLIENT_CREDENTIALS' } } } } }],
            AllowedTools: ['@wnkgateway/*'],
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
    new cdk.CfnOutput(this, 'emailAgentRuntimeArn', { value: emailAgent.agentRuntimeArn });
    new cdk.CfnOutput(this, 'backOfficeRuntimeArn', { value: backOffice.agentRuntimeArn });
    new cdk.CfnOutput(this, 'browserId', { value: browser.browserId });
  }
}
