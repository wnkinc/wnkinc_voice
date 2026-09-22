import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpSqsIntegration, HttpStepFunctionsIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { dlqAlarm, errorAlarm, failedExecutionsAlarm } from '../infra_utils/alarms.js';
import { BROWSERBASE_API, COMPOSIO_API } from '../workflows/asl.js';
import { expressNoData, grantHttp } from '../infra_utils/state-machine.js';
import { browserLoginDefinition } from '../workflows/assistant/browser-login.js';
import { callEndedDefinition } from '../workflows/receptionist/call-ended.js';
import { assistantHealthDefinition } from '../workflows/canaries/assistant-health.js';
import { ASSISTANT_LOOP_ENDPOINTS } from '../workflows/assistant/assistant-loop.js';
import { composioHealthDefinition } from '../workflows/canaries/composio-health.js';
import { smsDefinition, TWILIO_API } from '../workflows/assistant/sms.js';
import { telegramDefinition } from '../workflows/assistant/telegram.js';
import { Construct } from 'constructs';

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** EventBridge Connection carrying the OpenAI API key (voice stack owns it); the assistant loop calls the model through it. */
  readonly openaiConnection: events.IConnection;
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
  /** The approval ledger; the SMS workflow's Facebook states read and write the person's rows. */
  readonly actionsTable: dynamodb.ITable;
  /** The platform HTTP API; the Telegram and SMS webhook routes are added here. */
  readonly api: apigwv2.IHttpApi;
  readonly alarmTopic: sns.ITopic;
  /** Platform memory: the assistant loop reads and writes each person's session and recalls their facts; the call-ended workflow writes transcripts. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The platform's assistant (the agent loop inside the Telegram and SMS
 * workflows; no runtime) and the platform workflows every tenant shares: the
 * call-ended tail (memory, usage), the browser login handoff, and the two
 * canaries. Per-tenant automations are in TenantStack. Each definition lives
 * in workflows/; this stack wraps it in a state machine, routes its event to
 * it, and grants what it touches. One piece of code: the media link resolver
 * (packages/media-link), for the one thing a workflow cannot read.
 */
export class RuntimeStack extends cdk.Stack {
  /** Twilio credentials and the generated webhook path; the worker stack's SMS route and replies use them too. */
  readonly twilioSecret: secretsmanager.Secret;
  /** The media link resolver; the worker's activities invoke it. */
  readonly mediaLinkFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // ---- My Assistant: Telegram -> API Gateway -> Step Functions (the loop) --
    //
    // No code and no runtime on this path. The agent loop is states inside
    // the workflow (workflows/assistant/assistant-loop.ts): the model through the
    // OpenAI Connection, each tool the model asks for run through the
    // Composio Connection naming the tenant, history and recall from the
    // platform Memory, the tenant row's tool list as the allow-list. The
    // reply leaves through an EventBridge API destination (Telegram wants
    // the bot token in the URL path, which no managed HTTP target can
    // inject, but a destination's endpoint can carry it).

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

    // What every machine that runs the loop needs: the two Connections and
    // Memory. One object and one grant, so the three cannot drift.
    const loopRefs = {
      openaiConnectionArn: props.openaiConnection.connectionArn,
      composioConnectionArn: props.composioConnection.connectionArn,
      memoryId: props.callerMemory?.memoryId,
      model: process.env.ASSISTANT_MODEL ?? 'gpt-5.5',
    };
    const grantLoop = (wf: sfn.StateMachine) => {
      grantHttp(wf, [props.openaiConnection, props.composioConnection], ASSISTANT_LOOP_ENDPOINTS);
      if (props.callerMemory) {
        wf.addToRolePolicy(new iam.PolicyStatement({
          actions: MEMORY_USE_ACTIONS,
          resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
        }));
      }
    };

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

    // ---- Browser login handoff (workflows/assistant/browser-login.ts) ---------------------
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
        ...loopRefs,
        browserLoginArn: loginWorkflow.stateMachineArn,
      }))),
      timeout: cdk.Duration.minutes(5),
    });
    props.peopleTable.grantReadData(workflow);
    props.tenantsTable.grantReadData(workflow);
    props.usageTable.grantWriteData(workflow);
    props.bus.grantPutEventsTo(workflow);
    loginWorkflow.grantStartExecution(workflow);
    grantLoop(workflow);
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

    // ---- My Assistant over SMS: Twilio -> API Gateway -> SQS -> Pipe -> Step Functions (the loop) --
    //
    // The same loop through a second front door (workflows/assistant/sms.ts). Twilio
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
    // The media link resolver: a texted photo's Twilio ids -> the signed link
    // Twilio redirects to. Code because Step Functions fails an HTTP task on a
    // 307 and keeps the Location header from the workflow. Invoked as a task
    // (synchronously), so its failures surface in the execution; no queue.
    const mediaLinkName = `${prefix}-media-link`;
    const mediaLinkFn = new NodejsFunction(this, 'MediaLink', {
      functionName: mediaLinkName,
      description: 'Texted photo ids -> the signed link Twilio redirects to (nothing fetched, nothing stored)',
      entry: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../media-link/src/media-link.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { TWILIO_SECRET_ARN: twilioSecret.secretArn, NODE_OPTIONS: '--enable-source-maps' },
      logGroup: new logs.LogGroup(this, 'MediaLinkLogs', { logGroupName: `/aws/lambda/${mediaLinkName}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      tracing: lambda.Tracing.ACTIVE,
      bundling: { format: OutputFormat.ESM, target: 'node22', mainFields: ['module', 'main'], sourceMap: true },
    });
    twilioSecret.grantRead(mediaLinkFn);
    this.twilioSecret = twilioSecret;
    this.mediaLinkFn = mediaLinkFn;
    errorAlarm(this, 'MediaLinkErrors', mediaLinkFn, props.alarmTopic, 'Media link resolver');

    const smsWorkflow = new sfn.StateMachine(this, 'SmsWorkflow', {
      stateMachineName: `${prefix}-sms`,
      tracingEnabled: true,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(smsDefinition({
        peopleTable: props.peopleTable.tableName,
        tenantsTable: props.tenantsTable.tableName,
        usageTable: props.usageTable.tableName,
        ...loopRefs,
        twilioConnectionArn: twilioConnection.connectionArn,
        facebook: { actionsTable: props.actionsTable.tableName, mediaLinkFunctionArn: mediaLinkFn.functionArn },
      }))),
      timeout: cdk.Duration.minutes(5),
    });
    props.actionsTable.grantReadWriteData(smsWorkflow);
    mediaLinkFn.grantInvoke(smsWorkflow);
    props.peopleTable.grantReadData(smsWorkflow);
    props.tenantsTable.grantReadData(smsWorkflow);
    props.usageTable.grantWriteData(smsWorkflow);
    grantLoop(smsWorkflow);
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

    // Call ended (workflows/receptionist/call-ended.ts): transcript -> memory, minutes -> usage.
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

    // Composio health canary (workflows/canaries/composio-health.ts): every morning,
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

    // Assistant health canary (workflows/canaries/assistant-health.ts): every morning,
    // make each tenant's assistant answer one read-only question. The alarms
    // around it only fire when a person's message fails; nobody messages the
    // bot on a quiet week, so this is the traffic that proves it still works.
    // Ten minutes after the connection check, so a failure here is about the
    // loop (model, Memory, tool execution) rather than about Composio.
    const assistantHealth = new sfn.StateMachine(this, 'AssistantHealthWorkflow', {
      stateMachineName: `${prefix}-assistant-health`,
      tracingEnabled: true,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(assistantHealthDefinition({
        tenantsTable: props.tenantsTable.tableName,
        ...loopRefs,
      }))),
      timeout: cdk.Duration.minutes(10),
    });
    props.tenantsTable.grantReadData(assistantHealth);
    grantLoop(assistantHealth);
    new events.Rule(this, 'AssistantHealthSchedule', {
      description: 'Daily assistant liveness probe for every tenant with the assistant on (15:10 UTC)',
      schedule: events.Schedule.cron({ minute: '10', hour: '15' }),
      targets: [new targets.SfnStateMachine(assistantHealth, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
    });
    failedExecutionsAlarm(this, 'AssistantHealthFailed', assistantHealth, props.alarmTopic, 'Assistant health: a tenant assistant did not answer');

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
