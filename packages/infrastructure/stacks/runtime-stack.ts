import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpStepFunctionsIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
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
import { crmCallDefinition } from '../workflows/crm-call.js';
import { composioHealthDefinition } from '../workflows/composio-health.js';
import { crmLeadDefinition } from '../workflows/crm-lead.js';
import { leadEmailDefinition } from '../workflows/lead-email.js';
import { ownerAlertDefinition } from '../workflows/owner-alert.js';
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
  /** Channel identity -> tenant + person; the Telegram workflow's one lookup. */
  readonly peopleTable: dynamodb.ITable;
  /** The platform HTTP API; the Telegram webhook route is added here. */
  readonly api: apigwv2.IHttpApi;
  readonly alarmTopic: sns.ITopic;
  /** Platform memory: the harness threads sessions and retrieves facts from it; the call-ended workflow writes transcripts. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The platform's agent, My Assistant (an AgentCore harness driven by the
 * Telegram workflow), and the deterministic workflows on bus events: CRM
 * sync, the call-ended tail (memory, usage), the lead email, and the owner
 * alert. Each definition lives in workflows/; this stack wraps it in a state
 * machine, routes its event to it, and grants what it touches. No code.
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

    // ---- Browser login handoff (workflows/browser-login.ts) ---------------------
    // The owner's `/login` opens a Browserbase session on the tenant's saved
    // browser and sends them the live view to sign in; the login persists for
    // later sessions. One platform project; each tenant's browser is a context
    // keyed on the row. Fill the secret after deploy, then redeploy (the project
    // id is resolved into the definition; the key into the Connection):
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"BROWSERBASE_API_KEY":"bb_live_...","BROWSERBASE_PROJECT_ID":"..."}'
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
        browserbaseProjectId: browserbaseSecret.secretValueFromJson('BROWSERBASE_PROJECT_ID').unsafeUnwrap(),
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

    // ---- Bus-driven workflows ---------------------------------------------------
    //
    // Each rule starts its workflow with the event; a start the rule could
    // not deliver (after retries) parks in startDlq and alarms, and an
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

    // Lead email (workflows/lead-email.ts). Express, no execution data: the
    // email body carries the CRM note. (Named -express because Standard ->
    // Express is a replacement, and CloudFormation creates the new machine
    // before deleting the old one of the same name.)
    const leadWorkflow = new sfn.StateMachine(this, 'LeadEmailWorkflow', {
      stateMachineName: `${prefix}-lead-email-express`,
      tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(leadEmailDefinition({
        tenantsTable: props.tenantsTable.tableName,
        callsTable: props.callsTable.tableName,
        usageTable: props.usageTable.tableName,
        composioConnectionArn,
        memoryId: props.callerMemory?.memoryId,
      }))),
      timeout: cdk.Duration.minutes(5),
      ...expressNoData(this, 'LeadEmailWorkflowLogs'),
    });
    props.tenantsTable.grantReadData(leadWorkflow);
    props.callsTable.grantReadWriteData(leadWorkflow);
    props.usageTable.grantWriteData(leadWorkflow);
    grantHttp(leadWorkflow, [props.composioConnection], [`${COMPOSIO_API}*`]);
    memoryGrant(leadWorkflow);
    route('LeadRule', 'lead.recorded', leadWorkflow, 'Route lead.recorded to the lead email workflow');
    failedExecutionsAlarm(this, 'LeadEmailWorkflowFailed', leadWorkflow, props.alarmTopic, 'Lead email');

    // CRM sync (workflows/crm-lead.ts, workflows/crm-call.ts).
    const crmLeadWorkflow = new sfn.StateMachine(this, 'CrmLeadWorkflow', {
      stateMachineName: `${prefix}-crm-lead`,
      tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(crmLeadDefinition({
        tenantsTable: props.tenantsTable.tableName,
        callsTable: props.callsTable.tableName,
        composioConnectionArn,
      }))),
      timeout: cdk.Duration.minutes(5),
    });
    const crmCallWorkflow = new sfn.StateMachine(this, 'CrmCallWorkflow', {
      stateMachineName: `${prefix}-crm-call`,
      tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(crmCallDefinition({
        tenantsTable: props.tenantsTable.tableName,
        callsTable: props.callsTable.tableName,
        composioConnectionArn,
      }))),
      timeout: cdk.Duration.minutes(5),
      ...expressNoData(this, 'CrmCallWorkflowLogs'),
    });
    for (const wf of [crmLeadWorkflow, crmCallWorkflow]) {
      props.tenantsTable.grantReadData(wf);
      props.callsTable.grantReadWriteData(wf);
      grantHttp(wf, [props.composioConnection], [`${COMPOSIO_API}*`]);
    }
    route('CrmLeadRule', 'lead.recorded', crmLeadWorkflow, 'Route lead.recorded to the CRM lead workflow');
    route('CrmCallRule', 'call.ended', crmCallWorkflow, 'Route call.ended to the CRM call workflow');
    failedExecutionsAlarm(this, 'CrmLeadWorkflowFailed', crmLeadWorkflow, props.alarmTopic, 'CRM sync (lead)');
    failedExecutionsAlarm(this, 'CrmCallWorkflowFailed', crmCallWorkflow, props.alarmTopic, 'CRM sync (call)');

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

    // Owner alert (workflows/owner-alert.ts): owner.notify -> the Telegram reply path.
    const alertWorkflow = new sfn.StateMachine(this, 'OwnerAlertWorkflow', {
      stateMachineName: `${prefix}-owner-alert`,
      tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(ownerAlertDefinition({
        tenantsTable: props.tenantsTable.tableName,
        busName: props.bus.eventBusName,
      }))),
      timeout: cdk.Duration.minutes(2),
    });
    props.tenantsTable.grantReadData(alertWorkflow);
    props.bus.grantPutEventsTo(alertWorkflow);
    route('OwnerAlertRule', 'owner.notify', alertWorkflow, 'Route owner.notify to the owner alert workflow');
    failedExecutionsAlarm(this, 'OwnerAlertWorkflowFailed', alertWorkflow, props.alarmTopic, 'Owner alert');
    dlqAlarm(this, 'LeadEmailDlqAlarm', startDlq, props.alarmTopic, 'Workflows: a lead.recorded or owner.notify event could not start its workflow');

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

    new cdk.CfnOutput(this, 'assistantHarnessArn', { value: harness.attrArn });
    new cdk.CfnOutput(this, 'leadEmailWorkflowArn', { value: leadWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'ownerAlertWorkflowArn', { value: alertWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'crmLeadWorkflowArn', { value: crmLeadWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'crmCallWorkflowArn', { value: crmCallWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'callEndedWorkflowArn', { value: endedWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'telegramSecretArn', { value: telegramSecret.secretArn });
    new cdk.CfnOutput(this, 'telegramWorkflowArn', { value: workflow.stateMachineArn });
    new cdk.CfnOutput(this, 'composioHealthWorkflowArn', { value: healthWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'browserbaseSecretArn', { value: browserbaseSecret.secretArn });
    new cdk.CfnOutput(this, 'browserLoginWorkflowArn', { value: loginWorkflow.stateMachineArn });
  }
}
