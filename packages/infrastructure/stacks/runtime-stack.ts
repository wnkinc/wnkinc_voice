import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpSqsIntegration, HttpStepFunctionsIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { dlqAlarm, failedExecutionsAlarm } from '../infra_utils/alarms.js';
import { BROWSERBASE_API, COMPOSIO_API } from '../workflows/asl.js';
import { expressNoData, grantHttp } from '../infra_utils/state-machine.js';
import { browserLoginDefinition } from '../workflows/browser-login.js';
import { callEndedDefinition } from '../workflows/call-ended.js';
import { assistantHealthDefinition } from '../workflows/assistant-health.js';
import { composioHealthDefinition } from '../workflows/composio-health.js';
import { smsDefinition, TWILIO_API } from '../workflows/sms.js';
import { telegramDefinition } from '../workflows/telegram.js';
import { Construct } from 'constructs';

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Identity API key provider holding the OpenAI key; the assistant harness reads the key from the vault. */
  readonly openaiProviderArn: string;
  /** Identity API key provider holding the Composio key; the harness resolves it into the MCP session header. */
  readonly composioProviderArn: string;
  /** EventBridge Connection carrying the Composio API key (voice stack owns it); every Composio HTTP task here authenticates through it. */
  readonly composioConnection: events.IConnection;
  readonly bus: events.IEventBus;
  readonly usageTable: dynamodb.ITable;
  /** Agents read their tenant's row to check the service is enabled and how it is configured. */
  readonly tenantsTable: dynamodb.ITable;
  /** Once-markers for "already emailed this lead" live on the call row. */
  readonly callsTable: dynamodb.ITable;
  /** Channel identity -> tenant + person; the Telegram and SMS workflows' one lookup. */
  readonly peopleTable: dynamodb.ITable;
  /** The platform HTTP API; the Telegram and SMS webhook routes are added here. */
  readonly api: apigwv2.IHttpApi;
  readonly alarmTopic: sns.ITopic;
  /** Platform memory: the harness threads sessions and retrieves facts from it; the call-ended workflow writes transcripts. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The platform's agent, My Assistant (an AgentCore harness driven by the
 * Telegram and SMS workflows), and the platform workflows every tenant shares: the
 * call-ended tail (memory, usage), the browser login handoff, and the
 * Composio health canary. Per-tenant automations are in TenantStack. Each
 * definition lives in workflows/; this stack wraps it in a state machine,
 * routes its event to it, and grants what it touches. No code.
 */
export class RuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // ---- My Assistant: Telegram -> API Gateway -> Step Functions -> harness --
    //
    // No code on this path. The assistant is an AgentCore HARNESS: model,
    // default prompt, memory, and limits are configuration below. Per
    // invocation the workflow (workflows/telegram.ts) passes the message, a
    // prompt built from the tenant row, and the tenant's Composio MCP session
    // (its URL on the row, bound to the owner's connected accounts), so the
    // only SaaS the model can reach is that tenant's. The reply leaves through
    // an EventBridge API destination (Telegram wants the bot token in the URL
    // path, which no managed HTTP target can inject — but a destination's
    // endpoint can carry it).

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
      // Nothing is lost when the microVM goes (history is in Memory), but a
      // fresh one takes ~70 s to come up, which a person mid-conversation
      // feels. Idle time is not a cost lever: the AWS/Bedrock-AgentCore
      // MemoryUsed-GBHours metric bills this harness a flat 8 GB every minute
      // the VM lives (~0.13 cents/min), so the timeout only buys warmth.
      // Fifteen minutes (the AWS default) covers a texting session; a longer
      // gap pays the cold start again.
      environment: { agentCoreRuntimeEnvironment: { lifecycleConfiguration: { idleRuntimeSessionTimeout: 900 } } },
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

    // ---- Browser login handoff (workflows/browser-login.ts) ---------------------
    // The owner's `/login` opens a Browserbase session on the tenant's saved
    // browser and sends them the live view to sign in; the login persists for
    // later sessions. One platform project (its id is cdk.json context: not a
    // secret, and a literal in the definition); each tenant's browser is a
    // context keyed on the row. The key: fill the secret after the first
    // deploy, then write it to the Connection too, because CloudFormation
    // resolves a secret reference only when the resource itself changes:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"BROWSERBASE_API_KEY":"bb_live_..."}'
    //   aws events update-connection --name <connection> --auth-parameters '{"ApiKeyAuthParameters":{"ApiKeyName":"X-BB-API-Key","ApiKeyValue":"bb_live_..."}}'
    const browserbaseProjectId = this.node.tryGetContext('browserbaseProjectId') as string | undefined;
    if (!browserbaseProjectId) throw new Error('cdk.json context "browserbaseProjectId" is required (the Browserbase project id; not a secret)');
    // Do not touch generateSecretString once deployed: any change to it makes
    // CloudFormation generate a NEW value, overwriting the key you stored. (The
    // BROWSERBASE_PROJECT_ID placeholder in the template is a leftover of the
    // first deploy, kept for that reason; the project id lives in cdk.json.)
    const browserbaseSecret = new secretsmanager.Secret(this, 'BrowserbaseSecret', {
      description: 'Browserbase: {"BROWSERBASE_API_KEY": <project API key>, "BROWSERBASE_PROJECT_ID": <project id>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ BROWSERBASE_PROJECT_ID: 'set-me' }),
        generateStringKey: 'BROWSERBASE_API_KEY',
        excludePunctuation: true,
      },
    });
    const browserbaseConnection = new events.Connection(this, 'BrowserbaseConnection', {
      description: 'Browserbase API key for the browser workflows',
      authorization: events.Authorization.apiKey('X-BB-API-Key', browserbaseSecret.secretValueFromJson('BROWSERBASE_API_KEY')),
    });
    const loginWorkflow = new sfn.StateMachine(this, 'BrowserLoginWorkflow', {
      stateMachineName: `${prefix}-browser-login`,
      tracingEnabled: true,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(browserLoginDefinition({
        tenantsTable: props.tenantsTable.tableName,
        busName: props.bus.eventBusName,
        browserbaseConnectionArn: browserbaseConnection.connectionArn,
        browserbaseProjectId,
      }))),
      timeout: cdk.Duration.minutes(20),
    });
    props.tenantsTable.grantReadWriteData(loginWorkflow);
    props.bus.grantPutEventsTo(loginWorkflow);
    grantHttp(loginWorkflow, [browserbaseConnection], [`${BROWSERBASE_API}*`]);
    failedExecutionsAlarm(this, 'BrowserLoginWorkflowFailed', loginWorkflow, props.alarmTopic, 'Browser login handoff');

    // ---- The Telegram workflow --------------------------------------------------
    const workflow = new sfn.StateMachine(this, 'TelegramWorkflow', {
      stateMachineName: `${prefix}-telegram`,
      tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(telegramDefinition({
        peopleTable: props.peopleTable.tableName,
        tenantsTable: props.tenantsTable.tableName,
        usageTable: props.usageTable.tableName,
        busName: props.bus.eventBusName,
        harnessArn: harness.attrArn,
        composioProviderArn: props.composioProviderArn,
        browserLoginArn: loginWorkflow.stateMachineArn,
      }))),
      timeout: cdk.Duration.minutes(5),
    });
    props.peopleTable.grantReadData(workflow);
    props.tenantsTable.grantReadData(workflow);
    props.usageTable.grantWriteData(workflow);
    props.bus.grantPutEventsTo(workflow);
    loginWorkflow.grantStartExecution(workflow);
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

    // ---- My Assistant over SMS: Twilio -> API Gateway -> SQS -> Pipe -> Step Functions -> harness --
    //
    // The same harness through a second front door (workflows/sms.ts). Twilio
    // posts each text form-encoded, which is not JSON, and API Gateway's
    // StartExecution mapping accepts only a JSON body or a single variable
    // (a static string embedding ${request.body} is rejected at deploy). So
    // the route drops the raw body on a queue (SendMessage takes any string)
    // and an EventBridge Pipe starts the workflow with it. No code; the queue
    // also gives the start a retry and a dead letter. The reply is an HTTP
    // task straight to Twilio's Messages API (form body, basic auth through
    // the Connection): an API destination cannot send a form body, so no
    // reply rule here. The credentials: fill the secret after the first
    // deploy, then write them to the Connection too, because CloudFormation
    // resolves a secret reference only when the resource itself changes:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"TWILIO_ACCOUNT_SID":"AC...","TWILIO_AUTH_TOKEN":"...","WEBHOOK_PATH":"<keep>"}'
    //   aws events update-connection --name <connection> --authorization-type BASIC --auth-parameters '{"BasicAuthParameters":{"Username":"AC...","Password":"..."}}'
    const twilioSecret = new secretsmanager.Secret(this, 'TwilioSecret', {
      description: 'Twilio: {"TWILIO_ACCOUNT_SID": <AC...>, "TWILIO_AUTH_TOKEN": <token>, "WEBHOOK_PATH": <generated>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TWILIO_ACCOUNT_SID: 'set-me', TWILIO_AUTH_TOKEN: 'set-me' }),
        generateStringKey: 'WEBHOOK_PATH',
        excludePunctuation: true,
        passwordLength: 40,
      },
    });
    const twilioConnection = new events.Connection(this, 'TwilioConnection', {
      description: 'Twilio REST API (basic auth: account SID + auth token) for SMS replies',
      authorization: events.Authorization.basic(twilioSecret.secretValueFromJson('TWILIO_ACCOUNT_SID').unsafeUnwrap(), twilioSecret.secretValueFromJson('TWILIO_AUTH_TOKEN')),
    });
    const smsWorkflow = new sfn.StateMachine(this, 'SmsWorkflow', {
      stateMachineName: `${prefix}-sms`,
      tracingEnabled: true,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(smsDefinition({
        peopleTable: props.peopleTable.tableName,
        tenantsTable: props.tenantsTable.tableName,
        usageTable: props.usageTable.tableName,
        harnessArn: harness.attrArn,
        composioProviderArn: props.composioProviderArn,
        twilioConnectionArn: twilioConnection.connectionArn,
      }))),
      timeout: cdk.Duration.minutes(5),
    });
    props.peopleTable.grantReadData(smsWorkflow);
    props.tenantsTable.grantReadData(smsWorkflow);
    props.usageTable.grantWriteData(smsWorkflow);
    smsWorkflow.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
      resources: [harness.attrArn, `${harness.attrArn}/*`],
    }));
    grantHttp(smsWorkflow, [twilioConnection], [`${TWILIO_API}*`]);
    failedExecutionsAlarm(this, 'SmsWorkflowFailed', smsWorkflow, props.alarmTopic, 'Assistant (SMS)');

    // Twilio posts here (scripts/twilio-webhook.mts points a tenant's number
    // at it); API Gateway puts the raw body on the queue and answers 200 at
    // once. The path segment is the secret. A message the pipe cannot start
    // the workflow with (after retries) dead-letters and alarms.
    const smsDlq = new sqs.Queue(this, 'SmsDlq', { retentionPeriod: cdk.Duration.days(14) });
    const smsQueue = new sqs.Queue(this, 'SmsQueue', {
      retentionPeriod: cdk.Duration.hours(1),
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: { queue: smsDlq, maxReceiveCount: 3 },
    });
    new apigwv2.HttpRoute(this, 'SmsRoute', {
      httpApi: props.api,
      routeKey: apigwv2.HttpRouteKey.with(`/sms/${twilioSecret.secretValueFromJson('WEBHOOK_PATH').unsafeUnwrap()}`, apigwv2.HttpMethod.POST),
      integration: new HttpSqsIntegration('SmsWebhook', {
        queue: smsQueue,
        subtype: apigwv2.HttpIntegrationSubtype.SQS_SEND_MESSAGE,
        parameterMapping: new apigwv2.ParameterMapping().custom('QueueUrl', smsQueue.queueUrl).custom('MessageBody', '$request.body'),
      }),
    });
    const smsPipeRole = new iam.Role(this, 'SmsPipeRole', { assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com') });
    smsQueue.grantConsumeMessages(smsPipeRole);
    smsWorkflow.grantStartExecution(smsPipeRole);
    new pipes.CfnPipe(this, 'SmsPipe', {
      name: `${prefix}-sms`,
      description: 'Each inbound text (one queue message) starts the SMS workflow',
      roleArn: smsPipeRole.roleArn,
      source: smsQueue.queueArn,
      sourceParameters: { sqsQueueParameters: { batchSize: 1 } },
      target: smsWorkflow.stateMachineArn,
      targetParameters: { stepFunctionStateMachineParameters: { invocationType: 'FIRE_AND_FORGET' } },
    });
    dlqAlarm(this, 'SmsDlqAlarm', smsDlq, props.alarmTopic, 'Assistant (SMS): a text could not start the workflow');

    // ---- Platform workflows on the bus -------------------------------------------
    //
    // Only what every tenant gets identically and no tenant varies: the
    // call-ended tail (memory, usage) and the health canary. Tenant
    // automations (lead email, CRM sync, owner alert) live in each tenant's
    // own stack (stacks/tenant-stack.ts, tenants/<id>.ts). A start the rule
    // could not deliver (after retries) parks in startDlq and alarms, and an
    // execution that started and failed alarms through the workflow metric.
    const startDlq = new sqs.Queue(this, 'LeadEmailDlq', { retentionPeriod: cdk.Duration.days(14) });
    const route = (id: string, detailType: string, wf: sfn.StateMachine, description: string) => new events.Rule(this, id, {
      eventBus: props.bus,
      description,
      eventPattern: { source: ['wnkinc.voice'], detailType: [detailType] },
      targets: [new targets.SfnStateMachine(wf, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    const memoryGrant = (wf: sfn.StateMachine) => {
      if (!props.callerMemory) return;
      wf.addToRolePolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    };
    const composioConnectionArn = props.composioConnection.connectionArn;

    // Call ended (workflows/call-ended.ts): transcript -> memory, minutes -> usage.
    const endedWorkflow = new sfn.StateMachine(this, 'CallEndedWorkflow', {
      stateMachineName: `${prefix}-call-ended`,
      tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(callEndedDefinition({
        callsTable: props.callsTable.tableName,
        usageTable: props.usageTable.tableName,
        memoryId: props.callerMemory?.memoryId,
      }))),
      timeout: cdk.Duration.minutes(2),
      ...expressNoData(this, 'CallEndedWorkflowLogs'),
    });
    props.callsTable.grantReadWriteData(endedWorkflow);
    props.usageTable.grantWriteData(endedWorkflow);
    memoryGrant(endedWorkflow);
    route('CallEndedRule', 'call.ended', endedWorkflow, 'Route call.ended to the call-ended workflow (memory, usage)');
    failedExecutionsAlarm(this, 'CallEndedWorkflowFailed', endedWorkflow, props.alarmTopic, 'Call ended (memory, usage)');

    dlqAlarm(this, 'LeadEmailDlqAlarm', startDlq, props.alarmTopic, 'Platform workflows: an event could not start the call-ended workflow or the health canary');

    // Composio health canary (workflows/composio-health.ts): every morning,
    // prove each tenant's connections are still ACTIVE. A revoked connection
    // fails nothing on its own (every CRM and Gmail state catches and carries
    // on), so this turns the silence into a failed execution, which alarms.
    const healthWorkflow = new sfn.StateMachine(this, 'ComposioHealthWorkflow', {
      stateMachineName: `${prefix}-composio-health`,
      tracingEnabled: true,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(composioHealthDefinition({
        tenantsTable: props.tenantsTable.tableName,
        composioConnectionArn,
      }))),
      timeout: cdk.Duration.minutes(5),
    });
    props.tenantsTable.grantReadData(healthWorkflow);
    grantHttp(healthWorkflow, [props.composioConnection], [`${COMPOSIO_API}*`]);
    new events.Rule(this, 'ComposioHealthSchedule', {
      description: 'Daily Composio connection check for every tenant (15:00 UTC = morning in the US)',
      schedule: events.Schedule.cron({ minute: '0', hour: '15' }),
      targets: [new targets.SfnStateMachine(healthWorkflow, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    failedExecutionsAlarm(this, 'ComposioHealthFailed', healthWorkflow, props.alarmTopic, 'Composio health: a tenant has lost a connection');

    // Assistant health canary (workflows/assistant-health.ts): every morning,
    // make each tenant's assistant answer one read-only question. The alarms
    // around it only fire when a person's message fails; nobody messages the
    // bot on a quiet week, so this is the traffic that proves it still works.
    // Ten minutes after the connection check, so a failure here is about the
    // harness rather than about Composio.
    const assistantHealth = new sfn.StateMachine(this, 'AssistantHealthWorkflow', {
      stateMachineName: `${prefix}-assistant-health`,
      tracingEnabled: true,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(assistantHealthDefinition({
        tenantsTable: props.tenantsTable.tableName,
        harnessArn: harness.attrArn,
        composioProviderArn: props.composioProviderArn,
      }))),
      timeout: cdk.Duration.minutes(10),
    });
    props.tenantsTable.grantReadData(assistantHealth);
    assistantHealth.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
      resources: [harness.attrArn, `${harness.attrArn}/*`],
    }));
    new events.Rule(this, 'AssistantHealthSchedule', {
      description: 'Daily assistant liveness probe for every tenant with the assistant on (15:10 UTC)',
      schedule: events.Schedule.cron({ minute: '10', hour: '15' }),
      targets: [new targets.SfnStateMachine(assistantHealth, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    failedExecutionsAlarm(this, 'AssistantHealthFailed', assistantHealth, props.alarmTopic, 'Assistant health: a tenant assistant did not answer');

    new cdk.CfnOutput(this, 'assistantHarnessArn', { value: harness.attrArn });
    new cdk.CfnOutput(this, 'callEndedWorkflowArn', { value: endedWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'telegramSecretArn', { value: telegramSecret.secretArn });
    new cdk.CfnOutput(this, 'telegramWorkflowArn', { value: workflow.stateMachineArn });
    new cdk.CfnOutput(this, 'twilioSecretArn', { value: twilioSecret.secretArn });
    new cdk.CfnOutput(this, 'smsWorkflowArn', { value: smsWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'composioHealthWorkflowArn', { value: healthWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'browserbaseSecretArn', { value: browserbaseSecret.secretArn });
    new cdk.CfnOutput(this, 'browserLoginWorkflowArn', { value: loginWorkflow.stateMachineArn });
  }
}
