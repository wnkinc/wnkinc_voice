/**
 * The receptionist: the call path. API Gateway (the platform's) -> the
 * verifier Lambda (signature only) -> accept (tenant, claim, recognize,
 * accept, the session job) -> SQS -> the session Lambda (the WebSocket to
 * OpenAI for one call). Every after-call step is an event on the platform bus
 * that a workflow on the worker consumes. Takes the platform's handles;
 * owns only what runs on a call.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { dlqAlarm, errorAlarm } from '../infra_utils/alarms.js';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';
import { EVENT_SOURCE } from './platform-stack.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const receptionistSrc = (file: string) => path.resolve(here, '../../receptionist/src', file);

export interface ReceptionistStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Ceiling on simultaneous calls (SQS scaling config minimum is 2). */
  readonly sessionMaxConcurrency?: number;
  /** Caller memory (AgentCore Memory): accept recalls, the session writes. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
  readonly tenantsTable: dynamodb.ITable;
  readonly callsTable: dynamodb.ITable;
  readonly bus: events.IEventBus;
  readonly api: apigwv2.IHttpApi;
  readonly alarmTopic: sns.ITopic;
  readonly openaiSecret: secretsmanager.ISecret;
  readonly composioSecret: secretsmanager.ISecret;
}

export class ReceptionistStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ReceptionistStackProps) {
    super(scope, id, props);
    const { prefix, sessionMaxConcurrency = 20 } = props;

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
      TENANTS_TABLE: props.tenantsTable.tableName,
      CALLS_TABLE: props.callsTable.tableName,
      EVENT_BUS_NAME: props.bus.eventBusName,
      EVENT_SOURCE,
      OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
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
        entry: receptionistSrc(entryFile),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: opts.timeout,
        environment: { ...commonEnv, ...(opts.env ?? {}) },
        logGroup,
        tracing: lambda.Tracing.ACTIVE, // X-Ray: one trace from webhook through queue, call, events, and workflows
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
    // and no API Gateway authorizer can see. It checks the signature and hands
    // the body to accept; stdlib crypto plus the runtime's AWS SDK, no bundle.
    const webhookFn = fn('webhook', 'webhook.ts', {
      description: 'Verifies the OpenAI webhook signature and hands the body to accept',
      timeout: cdk.Duration.seconds(10),
    });
    props.openaiSecret.grantRead(webhookFn);

    const sessionFn = fn('session', 'session.ts', {
      description: 'Holds the OpenAI Realtime WebSocket for one call and runs the tool loop; nothing else',
      timeout: cdk.Duration.seconds(900),
    });
    props.openaiSecret.grantRead(sessionFn);
    props.tenantsTable.grantReadData(sessionFn);
    props.callsTable.grantReadWriteData(sessionFn);
    props.bus.grantPutEventsTo(sessionFn);
    sessionFn.addEventSource(new SqsEventSource(sessionQueue, {
      batchSize: 1, // one call per invocation
      reportBatchItemFailures: true,
      maxConcurrency: sessionMaxConcurrency,
    }));

    // Accept (packages/receptionist/src/accept.ts): verified webhook -> tenant ->
    // claim -> recognize -> accept -> enqueue. Plain code, invoked asynchronously
    // by the verifier (so OpenAI gets its 200 at once): a request handler on the
    // call path, where a cold orchestrator would ring in the caller's ear. A
    // failed attempt is retried by Lambda (the claim is idempotent) and then
    // dead-letters and alarms.
    const acceptDlq = new sqs.Queue(this, 'AcceptDlq', { retentionPeriod: cdk.Duration.days(14) });
    const acceptFn = fn('accept', 'accept.ts', {
      description: 'Called number -> tenant, claim, caller recognition while it rings, accept, the session job',
      timeout: cdk.Duration.seconds(30),
      env: {
        SESSION_QUEUE_URL: sessionQueue.queueUrl,
        COMPOSIO_SECRET_ARN: props.composioSecret.secretArn,
        ...(props.callerMemory ? { MEMORY_ID: props.callerMemory.memoryId } : {}),
      },
      deadLetterQueue: acceptDlq,
    });
    props.openaiSecret.grantRead(acceptFn);
    props.composioSecret.grantRead(acceptFn);
    props.tenantsTable.grantReadData(acceptFn);
    props.callsTable.grantReadWriteData(acceptFn);
    sessionQueue.grantSendMessages(acceptFn);
    if (props.callerMemory) {
      acceptFn.addToRolePolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }
    webhookFn.addEnvironment('ACCEPT_FUNCTION_NAME', acceptFn.functionName);
    acceptFn.grantInvoke(webhookFn);

    // ---- The front door, on the platform's API ----------------------------------------
    new apigwv2.HttpRoute(this, 'WebhookRoute', {
      httpApi: props.api,
      routeKey: apigwv2.HttpRouteKey.with('/openai/webhook', apigwv2.HttpMethod.POST),
      integration: new HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // ---- Alarms ---------------------------------------------------------------
    // Two questions, answered by CloudWatch: is anything failing right now
    // (function errors), and did anything fail for good (dead-letter queues).
    errorAlarm(this, 'WebhookErrors', webhookFn, props.alarmTopic, 'Receptionist webhook');
    errorAlarm(this, 'AcceptErrors', acceptFn, props.alarmTopic, 'Receptionist accept');
    errorAlarm(this, 'SessionErrors', sessionFn, props.alarmTopic, 'Receptionist session');
    dlqAlarm(this, 'AcceptDlqAlarm', acceptDlq, props.alarmTopic, 'Receptionist accept: a call could not be accepted after retries');
    dlqAlarm(this, 'SessionDlqAlarm', sessionDlq, props.alarmTopic, 'Receptionist: a session could not attach to a call');

    // ---- Outputs --------------------------------------------------------------
    /** Register this for `realtime.call.incoming` at platform.openai.com -> Settings -> Webhooks. */
    new cdk.CfnOutput(this, 'webhookUrl', { value: `${props.api.apiEndpoint}/openai/webhook` });
    new cdk.CfnOutput(this, 'sessionQueueUrl', { value: sessionQueue.queueUrl });
    new cdk.CfnOutput(this, 'sessionFunctionName', { value: sessionFn.functionName });
  }
}
