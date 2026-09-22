import * as cdk from 'aws-cdk-lib';
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
import { COMPOSIO_API } from '../workflows/asl.js';
import { expressNoData, grantHttp } from '../infra_utils/state-machine.js';
import { callEndedDefinition } from '../workflows/receptionist/call-ended.js';
import { composioHealthDefinition } from '../workflows/canaries/composio-health.js';
import { Construct } from 'constructs';

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** EventBridge Connection carrying the Composio API key (voice stack owns it); every Composio HTTP task here authenticates through it. */
  readonly composioConnection: events.IConnection;
  readonly bus: events.IEventBus;
  readonly usageTable: dynamodb.ITable;
  /** Agents read their tenant's row to check the service is enabled and how it is configured. */
  readonly tenantsTable: dynamodb.ITable;
  /** Once-markers for "already emailed this lead" live on the call row. */
  readonly callsTable: dynamodb.ITable;
  readonly alarmTopic: sns.ITopic;
  /** Platform memory: the call-ended workflow writes transcripts. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The platform workflows every tenant shares that still run on Step
 * Functions: the call-ended tail (memory, usage) and the Composio health
 * canary. Per-tenant automations are in TenantStack. Each definition lives in
 * workflows/; this stack wraps it in a state machine, routes its event to it,
 * and grants what it touches.
 *
 * The assistant (Telegram, SMS, the login handoff, the assistant canary) runs
 * in the Temporal worker (stacks/worker-stack.ts). What stays here for it are
 * the platform secrets it reads (Telegram, Twilio, Browserbase) and the media
 * link resolver its activities invoke, exposed as fields.
 */
export class RuntimeStack extends cdk.Stack {
  /** Twilio credentials and the generated webhook path; the worker stack's SMS route and replies use them. */
  readonly twilioSecret: secretsmanager.Secret;
  /** The media link resolver; the worker's activities invoke it. */
  readonly mediaLinkFn: lambda.IFunction;
  /** The bot token and the generated webhook path; the worker's Telegram route and replies use them. */
  readonly telegramSecret: secretsmanager.Secret;
  /** The Browserbase project key; the worker's login handoff uses it. */
  readonly browserbaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // ---- The secrets the worker's channels read ---------------------------------
    // Bot token (set by hand, see README) plus a generated secret path segment
    // for the webhook URL: Telegram's recommended way to authenticate posts.
    const telegramSecret = new secretsmanager.Secret(this, 'TelegramSecret', {
      description: 'Telegram bot: {"TELEGRAM_BOT_TOKEN": <from BotFather>, "WEBHOOK_PATH": <generated>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TELEGRAM_BOT_TOKEN: 'set-me' }),
        generateStringKey: 'WEBHOOK_PATH',
        excludePunctuation: true,
        passwordLength: 40,
      },
    });
    // Browserbase: one platform project (its id is cdk.json context: not a
    // secret); each tenant's browser is a context keyed on the row. Fill the
    // key after the first deploy:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"BROWSERBASE_API_KEY":"bb_live_..."}'
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
    // Twilio: the credentials the worker texts with and the media link resolver
    // asks Twilio with, plus a generated secret path segment for the webhook
    // URL. Fill after the first deploy (keep WEBHOOK_PATH):
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"TWILIO_ACCOUNT_SID":"AC...","TWILIO_AUTH_TOKEN":"...","WEBHOOK_PATH":"<keep>"}'
    const twilioSecret = new secretsmanager.Secret(this, 'TwilioSecret', {
      description: 'Twilio: {"TWILIO_ACCOUNT_SID": <AC...>, "TWILIO_AUTH_TOKEN": <token>, "WEBHOOK_PATH": <generated>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TWILIO_ACCOUNT_SID: 'set-me', TWILIO_AUTH_TOKEN: 'set-me' }),
        generateStringKey: 'WEBHOOK_PATH',
        excludePunctuation: true,
        passwordLength: 40,
      },
    });
    // The media link resolver: a texted photo's Twilio ids -> the signed link
    // Twilio redirects to. Code because the redirect's Location header is the
    // answer and nothing managed hands it back. Invoked synchronously by the
    // worker's activity, so its failures surface in the workflow; no queue.
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
    errorAlarm(this, 'MediaLinkErrors', mediaLinkFn, props.alarmTopic, 'Media link resolver');

    // ---- Platform workflows on the bus -------------------------------------------
    //
    // Only what every tenant gets identically and no tenant varies: the
    // call-ended tail (memory, usage) and the connection canary. Tenant
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

    new cdk.CfnOutput(this, 'callEndedWorkflowArn', { value: endedWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'telegramSecretArn', { value: telegramSecret.secretArn });
    new cdk.CfnOutput(this, 'twilioSecretArn', { value: twilioSecret.secretArn });
    new cdk.CfnOutput(this, 'composioHealthWorkflowArn', { value: healthWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'browserbaseSecretArn', { value: browserbaseSecret.secretArn });
    this.twilioSecret = twilioSecret;
    this.mediaLinkFn = mediaLinkFn;
    this.telegramSecret = telegramSecret;
    this.browserbaseSecret = browserbaseSecret;
  }
}
