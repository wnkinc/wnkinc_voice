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
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { dlqAlarm, errorAlarm, failedExecutionsAlarm } from '../infra_utils/alarms.js';
import { COMPOSIO_API, OPENAI_API } from '../workflows/asl.js';
import { expressNoData, grantHttp } from '../infra_utils/state-machine.js';
import { acceptDefinition } from '../workflows/accept.js';
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
  /** Caller memory (AgentCore Memory): the accept workflow recalls, the session writes. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The voice receptionist: API Gateway (HTTP) -> verifier Lambda (signature only)
 * -> accept workflow (tenant, claim, accept, recognize) -> SQS -> session Lambda
 * (WebSocket to OpenAI). DynamoDB: tenants (by called
 * number), calls. EventBridge bus: lead.recorded / owner.notify /
 * call.ended -> the runtime stack's workflows.
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
  /** EventBridge Connection carrying that key; every Composio HTTP task in every stack authenticates through it. */
  readonly composioConnection: events.Connection;
  /** Every alarm in every stack pages this topic. */
  readonly alarmTopic: sns.Topic;
  /** Channel identity -> tenant + person: `telegram:<id>` or `sms:<e164>`. Seeded from each tenant's `people`. */
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

    // One topic for every alarm on the platform. Who it pages is operator data,
    // not code: subscribe on the topic itself (`aws sns subscribe`, or the
    // console). Kept out of the template deliberately — a subscription CDK owns
    // is one a deploy without the variable set would silently delete, and the
    // failure mode of alerting is silence, which looks exactly like health.
    this.alarmTopic = new sns.Topic(this, 'Alarms', { topicName: `${prefix}-alarms`, displayName: 'WNK platform alarms' });

    // Call jobs wait here until the session Lambda finishes the call. Visibility
    // must cover the Lambda timeout (16 min), so a retry would reach a call that
    // ended long ago: a failed attach dead-letters at once and alarms instead.
    const sessionDlq = new sqs.Queue(this, 'SessionDlq', { retentionPeriod: cdk.Duration.days(14) });
    const sessionQueue = new sqs.Queue(this, 'SessionQueue', {
      visibilityTimeout: cdk.Duration.seconds(960),
      retentionPeriod: cdk.Duration.hours(1), // a call older than an hour is over
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: { queue: sessionDlq, maxReceiveCount: 1 },
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

    // The verifier: the one piece of the call path that must be code. The
    // webhook HMAC covers the raw body, which no managed integration computes
    // and no API Gateway authorizer can see. It checks the signature and starts
    // the accept workflow; stdlib crypto plus the runtime's AWS SDK, no bundle.
    const webhookFn = fn('webhook', 'webhook.ts', {
      description: 'Verifies the OpenAI webhook signature and starts the accept workflow',
      timeout: cdk.Duration.seconds(10),
    });
    this.openaiSecret.grantRead(webhookFn);

    const sessionFn = fn('session', 'session.ts', {
      description: 'Holds the OpenAI Realtime WebSocket for one call and runs the tool loop; nothing else',
      timeout: cdk.Duration.seconds(900),
    });
    this.openaiSecret.grantRead(sessionFn);
    this.tenantsTable.grantReadData(sessionFn);
    this.callsTable.grantReadWriteData(sessionFn);
    this.bus.grantPutEventsTo(sessionFn);
    sessionFn.addEventSource(new SqsEventSource(sessionQueue, {
      batchSize: 1, // one call per invocation
      reportBatchItemFailures: true,
      maxConcurrency: sessionMaxConcurrency,
    }));

    // Composio: Gmail + HubSpot credential broker (their verified OAuth apps;
    // tokens in their vault keyed by our tenant id). Fill after deploy:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"COMPOSIO_API_KEY":"ak_..."}'
    this.composioSecret = new secretsmanager.Secret(this, 'ComposioSecret', {
      description: 'Composio project API key ({"COMPOSIO_API_KEY": ...})',
    });
    // ---- Accept workflow (workflows/accept.ts): verified webhook -> tenant ->
    // claim -> accept -> recognize -> enqueue. Express, execution data not
    // logged. The API keys ride in EventBridge Connections (resolved from the
    // secrets when the Connection is created or changed; CloudFormation does
    // not re-resolve on a rotation alone, so also `aws events update-connection`).
    this.composioConnection = new events.Connection(this, 'ComposioConnection', {
      description: 'Composio API key for the platform workflows (voice + runtime stacks)',
      authorization: events.Authorization.apiKey('x-api-key', this.composioSecret.secretValueFromJson('COMPOSIO_API_KEY')),
    });
    const openaiConnection = new events.Connection(this, 'OpenAIConnection', {
      description: 'OpenAI API key for the accept workflow',
      authorization: events.Authorization.apiKey('Authorization', cdk.SecretValue.unsafePlainText(`Bearer ${this.openaiSecret.secretValueFromJson('OPENAI_API_KEY').unsafeUnwrap()}`)),
    });
    const acceptWorkflow = new sfn.StateMachine(this, 'AcceptWorkflow', {
      stateMachineName: `${prefix}-accept`,
      tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(acceptDefinition({
        tenantsTable: this.tenantsTable.tableName,
        callsTable: this.callsTable.tableName,
        sessionQueueUrl: sessionQueue.queueUrl,
        openaiConnectionArn: openaiConnection.connectionArn,
        composioConnectionArn: this.composioConnection.connectionArn,
        memoryId: props.callerMemory?.memoryId,
      }))),
      timeout: cdk.Duration.minutes(2),
      ...expressNoData(this, 'AcceptWorkflowLogs'),
    });
    this.tenantsTable.grantReadData(acceptWorkflow);
    this.callsTable.grantReadWriteData(acceptWorkflow);
    sessionQueue.grantSendMessages(acceptWorkflow);
    grantHttp(acceptWorkflow, [this.composioConnection, openaiConnection], [`${COMPOSIO_API}*`, `${OPENAI_API}*`]);
    if (props.callerMemory) {
      acceptWorkflow.addToRolePolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }
    webhookFn.addEnvironment('ACCEPT_WORKFLOW_ARN', acceptWorkflow.stateMachineArn);
    acceptWorkflow.grantStartExecution(webhookFn);
    failedExecutionsAlarm(this, 'AcceptWorkflowFailed', acceptWorkflow, this.alarmTopic, 'Voice accept');


    // ---- Event routing --------------------------------------------------------

    // Every consumer of lead.recorded / owner.notify / call.ended is a Step
    // Functions workflow in the runtime stack; the rules live there.
    //
    // Except this one: every event from both sources lands in one log group
    // as the platform's activity record. Nothing else retains bus events. It
    // is per tenant by construction (each event carries detail.tenantId) and
    // keeps the same 90-day window as the Calls row TTL, so both stores
    // answer "what happened for tenant X" over the same period.
    const activityLog = new logs.LogGroup(this, 'ActivityLog', {
      logGroupName: `/wnk/${prefix}/activity`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new events.Rule(this, 'ActivityLogRule', {
      eventBus: this.bus,
      description: 'Record every platform event in the activity log group',
      eventPattern: { source: ['wnkinc.voice', 'wnkinc.assistant'] },
      targets: [new targets.CloudWatchLogGroup(activityLog)],
    });

    // ---- Alarms ---------------------------------------------------------------
    // Two questions, answered by CloudWatch: is anything failing right now
    // (function errors), and did anything fail for good (dead-letter queues).

    dlqAlarm(this, 'SessionDlqAlarm', sessionDlq, this.alarmTopic, 'Voice: a session could not attach to a call');
    errorAlarm(this, 'WebhookErrors', webhookFn, this.alarmTopic, 'Voice webhook');
    errorAlarm(this, 'SessionErrors', sessionFn, this.alarmTopic, 'Voice session');

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
    /** Subscribe an address here once; no deploy touches the subscribers. */
    new cdk.CfnOutput(this, 'alarmTopicArn', { value: this.alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'sessionQueueUrl', { value: sessionQueue.queueUrl });
    new cdk.CfnOutput(this, 'sessionFunctionName', { value: sessionFn.functionName });
  }
}
