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
 * The front doors: SMS (Twilio -> API Gateway -> SQS -> the starter -> a
 * workflow per text), Telegram (API Gateway -> the starter -> a workflow
 * per update), and the automations (a tenant stack's rule -> the starter ->
 * the named workflow for the event), each starter the same image with a
 * different handler.
 *
 * The fallback: the same image as a Fargate service at zero tasks
 * (packages/worker/src/service.ts). Serverless Workers are a preview; if the
 * Lambda path misbehaves, set the desired count to one and the queue drains,
 * no release needed. Both write the same log group, where two metric filters
 * on the SDK's own lines raise the alarms: a failed workflow (what a failed
 * execution was on Step Functions) and a run of failed activities.
 *
 * After a deploy the version is registered with Temporal (deployment name and
 * build id from packages/worker/src/version.ts) and set current; see
 * scripts/temporal-release.mts (npm run release).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration, HttpSqsIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
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
  /** Transcripts and once-markers, read and written by the automations. */
  readonly callsTable: dynamodb.ITable;
  readonly peopleTable: dynamodb.ITable;
  readonly actionsTable: dynamodb.ITable;
  readonly usageTable: dynamodb.ITable;
  readonly openaiSecret: secretsmanager.ISecret;
  readonly composioSecret: secretsmanager.ISecret;
  /** Twilio credentials and the generated webhook path segment. */
  readonly twilioSecret: secretsmanager.ISecret;
  /** The Telegram bot token and the generated webhook path segment. */
  readonly telegramSecret: secretsmanager.ISecret;
  /** The Browserbase project API key; the project id is cdk.json context, not a secret. */
  readonly browserbaseSecret: secretsmanager.ISecret;
  readonly browserbaseProjectId: string;
  /** The media link resolver (packages/media-link). */
  readonly mediaLinkFunction: lambda.IFunction;
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
  readonly api: apigwv2.IHttpApi;
  /** The platform bus: the rule every tenant gets identically (call.ended) lives here. */
  readonly bus: events.IEventBus;
}

export class WorkerStack extends cdk.Stack {
  /** Each tenant stack's rules target this: it opens the named automation workflow with the event. */
  readonly automationStart: lambda.IFunction;

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
    // One image for the worker, the starter and the fallback: the handler differs.
    const asset = new DockerImageAsset(this, 'Image', { directory: PACKAGE_DIR, platform: Platform.LINUX_ARM64, exclude: ['node_modules', 'lib', 'test', '*.md'] });
    const image = (cmd: string) => lambda.DockerImageCode.fromEcr(asset.repository, { tagOrDigest: asset.imageTag, cmd: [cmd] });
    const logGroup = (name: string, cid: string) => new logs.LogGroup(this, cid, { logGroupName: `/aws/lambda/${name}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });
    // What the activities reach, by name. Tenant config stays in the tenant row.
    const workerEnv = {
      TEMPORAL_SECRET_ARN: secret.secretArn,
      NODE_OPTIONS: '--enable-source-maps',
      PEOPLE_TABLE: props.peopleTable.tableName,
      TENANTS_TABLE: props.tenantsTable.tableName,
      ACTIONS_TABLE: props.actionsTable.tableName,
      CALLS_TABLE: props.callsTable.tableName,
      USAGE_TABLE: props.usageTable.tableName,
      OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
      COMPOSIO_SECRET_ARN: props.composioSecret.secretArn,
      TWILIO_SECRET_ARN: props.twilioSecret.secretArn,
      TELEGRAM_SECRET_ARN: props.telegramSecret.secretArn,
      BROWSERBASE_SECRET_ARN: props.browserbaseSecret.secretArn,
      BROWSERBASE_PROJECT_ID: props.browserbaseProjectId,
      MEDIA_LINK_FUNCTION_ARN: props.mediaLinkFunction.functionArn,
      ASSISTANT_MODEL: process.env.ASSISTANT_MODEL ?? 'gpt-5.5',
      ...(props.callerMemory ? { MEMORY_ID: props.callerMemory.memoryId } : {}),
    };
    // What a worker may touch, whichever compute runs it.
    const grantWorker = (role: iam.IGrantable) => {
      secret.grantRead(role);
      props.openaiSecret.grantRead(role);
      props.composioSecret.grantRead(role);
      props.twilioSecret.grantRead(role);
      props.telegramSecret.grantRead(role);
      props.browserbaseSecret.grantRead(role);
      props.peopleTable.grantReadData(role);
      // Read for every turn; written by the login handoff (its window and the saved browser's id).
      props.tenantsTable.grantReadWriteData(role);
      props.actionsTable.grantReadWriteData(role);
      props.callsTable.grantReadWriteData(role);
      props.usageTable.grantWriteData(role);
      props.mediaLinkFunction.grantInvoke(role);
      if (props.callerMemory) {
        role.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({ actions: MEMORY_USE_ACTIONS, resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`] }));
      }
    };

    // ---- The Worker --------------------------------------------------------------
    const workerLogs = logGroup(fnName, 'Logs');
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
      environment: workerEnv,
      logGroup: workerLogs,
    });
    grantWorker(fn);
    errorAlarm(this, 'WorkerErrors', fn, props.alarmTopic, 'Temporal worker');

    // ---- The alarms, from the SDK's own log lines (JSON: the Powertools logger) --------
    // A failed workflow is what a failed execution was: one is a page. An
    // activity fails on every attempt it fails, so a run of them within an
    // hour is the signal, one is a retry.
    const failures = (id: string, message: string, name: string) => new logs.MetricFilter(this, id, {
      logGroup: workerLogs,
      filterPattern: logs.FilterPattern.all(logs.FilterPattern.stringValue('$.level', '=', 'WARN'), logs.FilterPattern.stringValue('$.message', '=', message)),
      metricNamespace: `${prefix}/temporal`, metricName: name, metricValue: '1', unit: cloudwatch.Unit.COUNT,
    }).metric({ statistic: 'Sum' });
    const alarm = (id: string, metric: cloudwatch.Metric, threshold: number, period: cdk.Duration, what: string) => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmDescription: what, metric: metric.with({ period }), threshold, evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new cwActions.SnsAction(props.alarmTopic));
    };
    alarm('WorkflowFailed', failures('WorkflowFailedFilter', 'Workflow failed', 'WorkflowFailed'), 1, cdk.Duration.minutes(5), 'Temporal: a workflow failed (an activity exhausted its retries, or the workflow threw)');
    alarm('ActivityFailures', failures('ActivityFailedFilter', 'Activity failed', 'ActivityFailed'), 5, cdk.Duration.hours(1), 'Temporal: five activity failures in an hour (a dependency is down, or a bug)');

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

    // ---- The Telegram front door ---------------------------------------------------
    // Telegram posts JSON and wants a 200 at once; the starter answers as soon
    // as the workflow is started. A start that fails answers 5xx, and Telegram
    // retries the same update id, which then starts nothing twice.
    const telegramStartName = `${prefix}-telegram-start`;
    const telegramStart = new lambda.DockerImageFunction(this, 'TelegramStart', {
      functionName: telegramStartName,
      description: 'Each Telegram update starts a telegramTurn workflow, keyed by the update id',
      code: image('lib/starter.telegram'),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      environment: { TEMPORAL_SECRET_ARN: secret.secretArn, NODE_OPTIONS: '--enable-source-maps' },
      logGroup: logGroup(telegramStartName, 'TelegramStartLogs'),
    });
    secret.grantRead(telegramStart);
    new apigwv2.HttpRoute(this, 'TelegramRoute', {
      httpApi: props.api,
      routeKey: apigwv2.HttpRouteKey.with(`/temporal/telegram/${props.telegramSecret.secretValueFromJson('WEBHOOK_PATH').unsafeUnwrap()}`, apigwv2.HttpMethod.POST),
      integration: new HttpLambdaIntegration('TelegramWebhook', telegramStart),
    });
    errorAlarm(this, 'TelegramStartErrors', telegramStart, props.alarmTopic, 'Assistant (Telegram, Temporal): starter');

    // ---- The automations' front door ------------------------------------------------
    // Each tenant stack's rules (stacks/tenant-stack.ts) invoke this with the
    // workflow name, the event, and the tenant's options; it opens the workflow
    // keyed by the lead or call, so a redelivery reruns only a run that failed.
    const automationStartName = `${prefix}-automation-start`;
    const automationStart = new lambda.DockerImageFunction(this, 'AutomationStart', {
      functionName: automationStartName,
      description: 'A tenant rule hands over a bus event; this starts the named automation workflow for it',
      code: image('lib/starter.automation'),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      environment: { TEMPORAL_SECRET_ARN: secret.secretArn, NODE_OPTIONS: '--enable-source-maps' },
      logGroup: logGroup(automationStartName, 'AutomationStartLogs'),
    });
    secret.grantRead(automationStart);
    errorAlarm(this, 'AutomationStartErrors', automationStart, props.alarmTopic, 'Automations (Temporal): starter');
    this.automationStart = automationStart;

    // The platform's own rule: what every tenant gets identically and no tenant
    // varies (the call-ended tail: memory, usage). Tenant automations are rules
    // in each tenant's stack (stacks/tenant-stack.ts) with the same target.
    const platformDlq = new sqs.Queue(this, 'PlatformStartDlq', { retentionPeriod: cdk.Duration.days(14) });
    new events.Rule(this, 'CallEndedRule', {
      eventBus: props.bus,
      description: 'call.ended -> callEnded (memory, usage), every tenant',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['call.ended'] },
      targets: [new targets.LambdaFunction(automationStart, {
        event: events.RuleTargetInput.fromObject({ workflow: 'callEnded', options: {}, detail: events.EventField.fromPath('$.detail'), id: events.EventField.eventId }),
        retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: platformDlq,
      })],
    });
    dlqAlarm(this, 'PlatformStartDlqAlarm', platformDlq, props.alarmTopic, 'Platform automations: an event could not start the call-ended workflow');

    // ---- The fallback: the same Worker, long-running, at zero -----------------------
    // Public subnets and a public IP, no NAT: the worker only makes outbound
    // calls, and a NAT gateway would cost more than the whole stack.
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }] });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: `${prefix}-worker` });
    const task = new ecs.FargateTaskDefinition(this, 'FallbackTask', { cpu: 1024, memoryLimitMiB: 2048, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
    task.addContainer('worker', {
      image: ecs.ContainerImage.fromDockerImageAsset(asset),
      // The Lambda base image's entrypoint is the Lambda runtime client; run node directly.
      entryPoint: ['/var/lang/bin/node', '/var/task/lib/service.js'],
      environment: workerEnv,
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogs, streamPrefix: 'fallback' }),
    });
    grantWorker(task.taskRole);
    const fallback = new ecs.FargateService(this, 'Fallback', {
      cluster, taskDefinition: task, serviceName: `${prefix}-worker-fallback`,
      desiredCount: 0, assignPublicIp: true, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minHealthyPercent: 0, maxHealthyPercent: 200,
    });

    new cdk.CfnOutput(this, 'functionArn', { value: fn.functionArn });
    new cdk.CfnOutput(this, 'fallbackService', { value: `aws ecs update-service --cluster ${cluster.clusterName} --service ${fallback.serviceName} --desired-count 1`, description: 'Brings up the fallback worker' });
    new cdk.CfnOutput(this, 'invokeRoleArn', { value: invoke.roleArn, description: 'The --aws-lambda-assume-role-arn when registering a version' });
    new cdk.CfnOutput(this, 'secretName', { value: secret.secretName });
    new cdk.CfnOutput(this, 'smsWebhookPath', { value: '/temporal/sms/<WEBHOOK_PATH from the Twilio secret>' });
    new cdk.CfnOutput(this, 'telegramWebhookPath', { value: '/temporal/telegram/<WEBHOOK_PATH from the Telegram secret>' });
  }
}
