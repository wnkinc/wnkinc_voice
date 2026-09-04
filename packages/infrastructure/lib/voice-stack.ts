import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { dlqAlarm, errorAlarm } from './alarms.js';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const voiceSrc = (file: string) => path.resolve(here, '../../voice-session/src', file);

const EVENT_SOURCE = 'wnkinc.voice';

export interface VoiceStackProps extends cdk.StackProps {
  /** Prefix for physical names, e.g. `wnkinc-voice-dev`. */
  readonly prefix: string;
  /** Ceiling on simultaneous calls (SQS scaling config minimum is 2). */
  readonly sessionMaxConcurrency?: number;
  /** Where alarms page. Optional: the topic exists either way; the email is the first subscriber. */
  readonly alarmEmail?: string;
  /** Caller memory (AgentCore Memory): webhook recalls, session writes. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The voice receptionist: API Gateway (HTTP) -> webhook Lambda -> [accept call]
 * -> SQS -> session Lambda (WebSocket to OpenAI). DynamoDB: tenants (by called
 * number), calls. EventBridge bus: lead.recorded / owner.notify /
 * call.ended -> the crm-sync Lambda here and the runtime stack's workflows.
 */
export class VoiceStack extends cdk.Stack {
  readonly tenantsTable: dynamodb.Table;
  readonly callsTable: dynamodb.Table;
  readonly bus: events.EventBus;
  /** Usage metering records: (tenantId, timestamp#meter) -> units. */
  readonly usageTable: dynamodb.Table;
  readonly openaiSecret: secretsmanager.Secret;
  /** Composio project API key ({"COMPOSIO_API_KEY": ...}): the SaaS credential broker every tenant's Gmail/HubSpot goes through. */
  readonly composioSecret: secretsmanager.Secret;
  /** Every alarm in every stack pages this topic. */
  readonly alarmTopic: sns.Topic;
  /** Channel identity -> tenant + person: `telegram:<id>` (and `sms:<e164>` later). Seeded from each tenant's `people`. */
  readonly peopleTable: dynamodb.Table;
  /** The platform's HTTP API; other stacks add their own routes to it. */
  readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: VoiceStackProps) {
    super(scope, id, props);
    const { prefix, sessionMaxConcurrency = 20 } = props;

    // ---- State ----------------------------------------------------------------

    this.openaiSecret = new secretsmanager.Secret(this, 'OpenAISecret', {
      description: 'OpenAI API key + webhook signing secret for the voice receptionist',
      // Set once at creation; real values are written with `aws secretsmanager put-secret-value`.
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ OPENAI_API_KEY: 'REPLACE_ME', OPENAI_WEBHOOK_SECRET: 'REPLACE_ME' }),
        generateStringKey: '_placeholder',
      },
    });

    this.tenantsTable = new dynamodb.Table(this, 'Tenants', {
      partitionKey: { name: 'phoneNumber', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // learning stack; flip to RETAIN for real data
    });

    this.peopleTable = new dynamodb.Table(this, 'People', {
      partitionKey: { name: 'channelId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.callsTable = new dynamodb.Table(this, 'Calls', {
      partitionKey: { name: 'callId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.callsTable.addGlobalSecondaryIndex({
      indexName: 'byTenant',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAt', type: dynamodb.AttributeType.STRING },
    });

    this.usageTable = new dynamodb.Table(this, 'Usage', {
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.bus = new events.EventBus(this, 'Events', { eventBusName: `${prefix}-events` });

    // One topic for every alarm on the platform. Subscribe an email at deploy
    // (ALARM_EMAIL) or add subscribers in the console — operator data, not code.
    this.alarmTopic = new sns.Topic(this, 'Alarms', { topicName: `${prefix}-alarms`, displayName: 'WNK platform alarms' });
    if (props.alarmEmail) this.alarmTopic.addSubscription(new subs.EmailSubscription(props.alarmEmail));

    // Call jobs wait here until the session Lambda finishes the call. Visibility
    // must cover the Lambda timeout; repeated failures land in the DLQ.
    const sessionDlq = new sqs.Queue(this, 'SessionDlq', { retentionPeriod: cdk.Duration.days(14) });
    // Where the CRM sync's message lands after Lambda's async retries are
    // exhausted, and where EventBridge parks an event it could not deliver at
    // all. Anything here is a lost sync.
    const eventsDlq = new sqs.Queue(this, 'EventsDlq', { retentionPeriod: cdk.Duration.days(14) });
    const sessionQueue = new sqs.Queue(this, 'SessionQueue', {
      visibilityTimeout: cdk.Duration.seconds(960),
      retentionPeriod: cdk.Duration.hours(1), // a call older than an hour is over
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: { queue: sessionDlq, maxReceiveCount: 3 },
    });

    // ---- Lambdas --------------------------------------------------------------

    const commonEnv = {
      TENANTS_TABLE: this.tenantsTable.tableName,
      CALLS_TABLE: this.callsTable.tableName,
      EVENT_BUS_NAME: this.bus.eventBusName,
      EVENT_SOURCE,
      OPENAI_SECRET_ARN: this.openaiSecret.secretArn,
      NODE_OPTIONS: '--enable-source-maps',
      LOG_LEVEL: 'info',
    };

    const fn = (id: string, entryFile: string, opts: { description: string; timeout: cdk.Duration; env?: Record<string, string>; deadLetterQueue?: sqs.IQueue }) => {
      const fnName = `${prefix}-${id}`;
      const logGroup = new logs.LogGroup(this, `${id}-logs`, {
        logGroupName: `/aws/lambda/${fnName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      return new NodejsFunction(this, id, {
        functionName: fnName,
        description: opts.description,
        entry: voiceSrc(entryFile),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: opts.timeout,
        environment: { ...commonEnv, ...(opts.env ?? {}) },
        logGroup,
        tracing: lambda.Tracing.ACTIVE, // X-Ray: one trace from webhook through queue, call, events, and agents
        deadLetterQueue: opts.deadLetterQueue,
        bundling: {
          format: OutputFormat.ESM,
          target: 'node22',
          mainFields: ['module', 'main'],
          sourceMap: true,
          // Some CJS deps (ws, aws-sdk internals) call require(); give them one in ESM.
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
      });
    };

    const webhookFn = fn('webhook', 'webhook.ts', {
      description: 'Verifies OpenAI realtime.call.incoming webhooks, routes to a tenant, accepts the call',
      timeout: cdk.Duration.seconds(15),
      env: { SESSION_QUEUE_URL: sessionQueue.queueUrl },
    });
    this.openaiSecret.grantRead(webhookFn);
    this.tenantsTable.grantReadData(webhookFn);
    this.callsTable.grantReadWriteData(webhookFn);
    sessionQueue.grantSendMessages(webhookFn);

    const sessionFn = fn('session', 'session.ts', {
      description: 'Holds the OpenAI Realtime WebSocket for one call and runs the tool loop',
      timeout: cdk.Duration.seconds(900),
    });
    sessionFn.addEnvironment('USAGE_TABLE', this.usageTable.tableName);
    this.usageTable.grantWriteData(sessionFn);
    if (props.callerMemory) {
      for (const f of [webhookFn, sessionFn]) {
        f.addEnvironment('MEMORY_ID', props.callerMemory.memoryId);
        f.addToRolePolicy(new iam.PolicyStatement({
          actions: MEMORY_USE_ACTIONS,
          resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
        }));
      }
    }
    this.openaiSecret.grantRead(sessionFn);
    this.tenantsTable.grantReadData(sessionFn);
    this.callsTable.grantReadWriteData(sessionFn);
    this.bus.grantPutEventsTo(sessionFn);
    sessionFn.addEventSource(new SqsEventSource(sessionQueue, {
      batchSize: 1, // one call per invocation
      reportBatchItemFailures: true,
      maxConcurrency: sessionMaxConcurrency,
    }));

    const crmSyncFn = fn('crm-sync', 'crm-sync.ts', {
      deadLetterQueue: eventsDlq,
      description: 'Syncs leads and call transcripts into the tenant CRM (HubSpot via Composio)',
      timeout: cdk.Duration.seconds(30),
    });
    this.tenantsTable.grantReadData(crmSyncFn);

    // Composio: Gmail + HubSpot credential broker (their verified OAuth apps;
    // tokens in their vault keyed by our tenant id). Fill after deploy:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"COMPOSIO_API_KEY":"ak_..."}'
    this.composioSecret = new secretsmanager.Secret(this, 'ComposioSecret', {
      description: 'Composio project API key ({"COMPOSIO_API_KEY": ...})',
    });
    // CRM sync and the webhook's caller recognition reach HubSpot through Composio.
    this.composioSecret.grantRead(crmSyncFn);
    crmSyncFn.addEnvironment('COMPOSIO_SECRET_ARN', this.composioSecret.secretArn);
    this.composioSecret.grantRead(webhookFn);
    webhookFn.addEnvironment('COMPOSIO_SECRET_ARN', this.composioSecret.secretArn);

    // ---- Event routing --------------------------------------------------------

    // lead.recorded and owner.notify are also consumed by the runtime stack's
    // workflows (lead email, owner alert); those rules live there.
    new events.Rule(this, 'CrmRule', {
      eventBus: this.bus,
      description: 'Route leads + call transcripts to the CRM sync',
      eventPattern: { source: [EVENT_SOURCE], detailType: ['lead.recorded', 'call.ended'] },
      targets: [new targets.LambdaFunction(crmSyncFn, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: eventsDlq })],
    });

    // ---- Alarms ---------------------------------------------------------------
    // Two questions, answered by CloudWatch: is anything failing right now
    // (function errors), and did anything fail for good (dead-letter queues).

    dlqAlarm(this, 'SessionDlqAlarm', sessionDlq, this.alarmTopic, 'Voice: a call job failed 3 times');
    dlqAlarm(this, 'EventsDlqAlarm', eventsDlq, this.alarmTopic, 'Events: a CRM sync was lost');
    errorAlarm(this, 'WebhookErrors', webhookFn, this.alarmTopic, 'Voice webhook');
    errorAlarm(this, 'SessionErrors', sessionFn, this.alarmTopic, 'Voice session');
    errorAlarm(this, 'CrmSyncErrors', crmSyncFn, this.alarmTopic, 'CRM sync');

    // ---- HTTP API -------------------------------------------------------------

    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `${prefix}-api`,
      description: 'Platform webhooks: OpenAI Realtime (here), Telegram (runtime stack)',
    });
    this.api = api;
    api.addRoutes({
      path: '/openai/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // ---- Outputs --------------------------------------------------------------

    /** Register this for `realtime.call.incoming` at platform.openai.com -> Settings -> Webhooks. */
    new cdk.CfnOutput(this, 'webhookUrl', { value: `${api.apiEndpoint}/openai/webhook` });
    new cdk.CfnOutput(this, 'openaiSecretArn', { value: this.openaiSecret.secretArn });
    new cdk.CfnOutput(this, 'composioSecretArn', { value: this.composioSecret.secretArn });
    new cdk.CfnOutput(this, 'apiEndpoint', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'tenantsTableName', { value: this.tenantsTable.tableName });
    new cdk.CfnOutput(this, 'peopleTableName', { value: this.peopleTable.tableName });
    new cdk.CfnOutput(this, 'callsTableName', { value: this.callsTable.tableName });
    new cdk.CfnOutput(this, 'eventBusName', { value: this.bus.eventBusName });
    new cdk.CfnOutput(this, 'sessionQueueUrl', { value: sessionQueue.queueUrl });
    new cdk.CfnOutput(this, 'sessionFunctionName', { value: sessionFn.functionName });
  }
}
