/**
 * The Temporal Worker (packages/worker) as a container Lambda that Temporal
 * Cloud invokes when its task queue has work: Serverless Workers, public
 * preview. Nothing here runs unless Temporal calls; idle costs nothing.
 *
 * Two roles, not to be confused: the function's execution role (what the
 * Worker may touch: the Temporal secret, the platform secrets its activities
 * read, the tables, the media link resolver, memory) and the invocation role
 * (what Temporal may do: invoke and describe this one function). Temporal
 * assumes the invocation role from its own accounts, gated by an external id
 * the secret generates here, so the guard never passes through a person.
 *
 * The SMS front door: Twilio -> API Gateway -> SQS -> the starter (the same
 * image, a different handler) -> a workflow per text. It sits beside the
 * Step Functions route until the cutover; a tenant's number is pointed at
 * one or the other (scripts/twilio-webhook.mts).
 *
 * After a deploy the version is registered with Temporal (deployment name and
 * build id from packages/worker/src/version.ts) and set current; see
 * scripts/temporal-release.mts.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpSqsIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { dlqAlarm, errorAlarm } from '../infra_utils/alarms.js';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../worker');

/** The Temporal Cloud accounts that invoke Serverless Workers (docs.temporal.io, serverless-workers/aws-lambda). */
export const TEMPORAL_CLOUD_INVOKERS = ['902542641901', '160190466495', '819232936619', '829909441867', '354116250941']
  .map((account) => `arn:aws:iam::${account}:role/wci-lambda-invoke`);

/** The platform secret holding the Temporal Cloud connection and the invocation guard. */
export const temporalSecretName = (prefix: string) => `${prefix}/temporal`;

export interface WorkerStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly alarmTopic: sns.ITopic;
  readonly tenantsTable: dynamodb.ITable;
  readonly peopleTable: dynamodb.ITable;
  readonly actionsTable: dynamodb.ITable;
  readonly usageTable: dynamodb.ITable;
  readonly openaiSecret: secretsmanager.ISecret;
  readonly composioSecret: secretsmanager.ISecret;
  /** Twilio credentials and the generated webhook path segment. */
  readonly twilioSecret: secretsmanager.ISecret;
  /** The media link resolver (packages/media-link). */
  readonly mediaLinkFunction: lambda.IFunction;
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
  readonly api: apigwv2.IHttpApi;
}

export class WorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    const { prefix } = props;
    const fnName = `${prefix}-worker`;

    // Address, namespace and API key are put in after the namespace exists
    // (ops, never a deploy variable); EXTERNAL_ID is generated here.
    const secret = new secretsmanager.Secret(this, 'Temporal', {
      secretName: temporalSecretName(prefix),
      description: 'Temporal Cloud: namespace address, namespace, the worker API key; EXTERNAL_ID guards the invocation role',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TEMPORAL_ADDRESS: '', TEMPORAL_NAMESPACE: '', TEMPORAL_API_KEY: '' }),
        generateStringKey: 'EXTERNAL_ID',
        passwordLength: 40,
        excludePunctuation: true,
      },
    });
    const image = (cmd: string) => lambda.DockerImageCode.fromImageAsset(PACKAGE_DIR, { platform: Platform.LINUX_ARM64, exclude: ['node_modules', 'lib', 'test', '*.md'], cmd: [cmd] });
    const logGroup = (name: string, cid: string) => new logs.LogGroup(this, cid, { logGroupName: `/aws/lambda/${name}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

    // ---- The Worker --------------------------------------------------------------
    const fn = new lambda.DockerImageFunction(this, 'Worker', {
      functionName: fnName,
      description: 'Temporal Worker: invoked by Temporal Cloud when the task queue has work',
      code: image('lib/handler.handler'),
      architecture: lambda.Architecture.ARM_64,
      // CPU scales with memory: at 1024 MB loading the SDK's native core overran
      // Lambda's 10 s init window and every cold start paid a second init.
      memorySize: 2048,
      // The invocation deadline: the Worker works until this minus its shutdown buffer.
      // Longer means fewer cold starts; an activity can never outlive it.
      timeout: cdk.Duration.minutes(10),
      environment: {
        TEMPORAL_SECRET_ARN: secret.secretArn,
        NODE_OPTIONS: '--enable-source-maps',
        // What the activities reach, by name. Tenant config stays in the tenant row.
        PEOPLE_TABLE: props.peopleTable.tableName,
        TENANTS_TABLE: props.tenantsTable.tableName,
        ACTIONS_TABLE: props.actionsTable.tableName,
        USAGE_TABLE: props.usageTable.tableName,
        OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
        COMPOSIO_SECRET_ARN: props.composioSecret.secretArn,
        TWILIO_SECRET_ARN: props.twilioSecret.secretArn,
        MEDIA_LINK_FUNCTION_ARN: props.mediaLinkFunction.functionArn,
        ASSISTANT_MODEL: process.env.ASSISTANT_MODEL ?? 'gpt-5.5',
        ...(props.callerMemory ? { MEMORY_ID: props.callerMemory.memoryId } : {}),
      },
      logGroup: logGroup(fnName, 'Logs'),
    });
    secret.grantRead(fn);
    props.openaiSecret.grantRead(fn);
    props.composioSecret.grantRead(fn);
    props.twilioSecret.grantRead(fn);
    props.peopleTable.grantReadData(fn);
    props.tenantsTable.grantReadData(fn);
    props.actionsTable.grantReadWriteData(fn);
    props.usageTable.grantWriteData(fn);
    props.mediaLinkFunction.grantInvoke(fn);
    if (props.callerMemory) {
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: MEMORY_USE_ACTIONS, resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`] }));
    }
    errorAlarm(this, 'WorkerErrors', fn, props.alarmTopic, 'Temporal worker');

    // ---- What Temporal may do -----------------------------------------------------
    const invoke = new iam.Role(this, 'Invoke', {
      roleName: `${prefix}-temporal-invoke`,
      description: 'Assumed by Temporal Cloud to invoke the worker when its task queue has work',
      assumedBy: new iam.CompositePrincipal(...TEMPORAL_CLOUD_INVOKERS.map((arn) => new iam.ArnPrincipal(arn)))
        .withConditions({ StringEquals: { 'sts:ExternalId': secret.secretValueFromJson('EXTERNAL_ID').unsafeUnwrap() } }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    // The unqualified function and every published version of it: a new build
    // id registers a new Lambda version, and the grant must already cover it.
    invoke.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction', 'lambda:GetFunction'], resources: [fn.functionArn, `${fn.functionArn}:*`] }));

    // ---- The SMS front door -------------------------------------------------------
    const smsDlq = new sqs.Queue(this, 'SmsDlq', { retentionPeriod: cdk.Duration.days(14) });
    const smsQueue = new sqs.Queue(this, 'SmsQueue', {
      retentionPeriod: cdk.Duration.hours(1),
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: smsDlq, maxReceiveCount: 3 },
    });
    new apigwv2.HttpRoute(this, 'SmsRoute', {
      httpApi: props.api,
      routeKey: apigwv2.HttpRouteKey.with(`/temporal/sms/${props.twilioSecret.secretValueFromJson('WEBHOOK_PATH').unsafeUnwrap()}`, apigwv2.HttpMethod.POST),
      integration: new HttpSqsIntegration('SmsWebhook', {
        queue: smsQueue,
        subtype: apigwv2.HttpIntegrationSubtype.SQS_SEND_MESSAGE,
        parameterMapping: new apigwv2.ParameterMapping().custom('QueueUrl', smsQueue.queueUrl).custom('MessageBody', '$request.body'),
      }),
    });
    const starterName = `${prefix}-sms-start`;
    const starter = new lambda.DockerImageFunction(this, 'SmsStart', {
      functionName: starterName,
      description: 'Each inbound text (one queue message) starts an smsTurn workflow, keyed by the message id',
      code: image('lib/starter.handler'),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: { TEMPORAL_SECRET_ARN: secret.secretArn, NODE_OPTIONS: '--enable-source-maps' },
      logGroup: logGroup(starterName, 'SmsStartLogs'),
    });
    secret.grantRead(starter);
    starter.addEventSource(new SqsEventSource(smsQueue, { batchSize: 1 }));
    errorAlarm(this, 'SmsStartErrors', starter, props.alarmTopic, 'Assistant (SMS, Temporal): starter');
    dlqAlarm(this, 'SmsDlqAlarm', smsDlq, props.alarmTopic, 'Assistant (SMS, Temporal): a text could not start the workflow');

    new cdk.CfnOutput(this, 'functionArn', { value: fn.functionArn });
    new cdk.CfnOutput(this, 'invokeRoleArn', { value: invoke.roleArn, description: 'The --aws-lambda-assume-role-arn when registering a version' });
    new cdk.CfnOutput(this, 'secretName', { value: secret.secretName });
    new cdk.CfnOutput(this, 'smsWebhookPath', { value: '/temporal/sms/<WEBHOOK_PATH from the Twilio secret>' });
  }
}
