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
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const voiceSrc = (file: string) => path.resolve(here, '../../voice-session/src', file);

const EVENT_SOURCE = 'wnkinc.voice';

export interface VoiceStackProps extends cdk.StackProps {
  /** Prefix for physical names, e.g. `wnkinc-voice-dev`. */
  readonly prefix: string;
  /** SES-verified sender for owner notifications ('' disables email). */
  readonly sesFromEmail?: string;
  /** Ceiling on simultaneous calls (SQS scaling config minimum is 2). */
  readonly sessionMaxConcurrency?: number;
  /**
   * Gateway wiring for the session Lambda's tool calls. `gatewayUrl` comes from
   * cdk.json context (a stable string) rather than a stack reference — the
   * gateway stack consumes this stack's tools Lambda, so a CFN reference in the
   * other direction would be a cycle. Unset: tools run in-process (first deploy).
   */
  readonly gateway?: {
    readonly gatewayUrl: string;
    readonly userPoolId: string;
    readonly clientId: string;
    readonly tokenUrl: string;
  };
  /** Caller memory (AgentCore Memory): webhook recalls, session writes. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * The voice receptionist: API Gateway (HTTP) -> webhook Lambda -> [accept call]
 * -> SQS -> session Lambda (WebSocket to OpenAI). DynamoDB: tenants (by called
 * number), calls, leads. EventBridge bus: lead.recorded / owner.notify /
 * call.ended -> notifier + crm-sync Lambdas.
 */
export class VoiceStack extends cdk.Stack {
  readonly tenantsTable: dynamodb.Table;
  readonly callsTable: dynamodb.Table;
  readonly leadsTable: dynamodb.Table;
  readonly bus: events.EventBus;
  /** Usage metering records: (tenantId, timestamp#meter) -> units. */
  readonly usageTable: dynamodb.Table;
  readonly openaiSecret: secretsmanager.Secret;
  /** Gateway Lambda target: record_lead + notify_owner as platform tools. */
  readonly gatewayToolsFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: VoiceStackProps) {
    super(scope, id, props);
    const { prefix, sesFromEmail = '', sessionMaxConcurrency = 20 } = props;

    // ---- State ----------------------------------------------------------------

    this.openaiSecret = new secretsmanager.Secret(this, 'OpenAISecret', {
      description: 'OpenAI API key + webhook signing secret for the voice receptionist',
      // Set once at creation; real values are written with `aws secretsmanager put-secret-value`.
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ OPENAI_API_KEY: 'REPLACE_ME', OPENAI_WEBHOOK_SECRET: 'REPLACE_ME' }),
        generateStringKey: '_placeholder',
      },
    });

    // Per-tenant CRM credentials at `${prefix}/crm/<tenantId>`. The secrets are
    // onboarding data, created by `aws secretsmanager create-secret` per tenant
    // (see the new-tenant skill) — this stack only grants the prefix.
    const crmSecretPrefix = `${prefix}/crm/`;
    const crmSecretArnPattern = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${crmSecretPrefix}*`;

    // MIGRATION SHIM — delete this block after one deploy. The wnk secret was
    // created by this stack before secrets became onboarding data. CloudFormation
    // deletes a removed resource unless the *deployed* template says Retain, so:
    // deploy once with RETAIN (this), then remove the block and deploy again to
    // orphan the secret with its real token intact.
    new secretsmanager.Secret(this, 'CrmSecret-wnk', {
      secretName: `${crmSecretPrefix}wnk`,
      description: 'CRM credentials for tenant wnk',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ HUBSPOT_TOKEN: 'REPLACE_ME' }),
        generateStringKey: '_placeholder',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.tenantsTable = new dynamodb.Table(this, 'Tenants', {
      partitionKey: { name: 'phoneNumber', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // learning stack; flip to RETAIN for real data
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

    this.leadsTable = new dynamodb.Table(this, 'Leads', {
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.usageTable = new dynamodb.Table(this, 'Usage', {
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.bus = new events.EventBus(this, 'Events', { eventBusName: `${prefix}-events` });

    // Call jobs wait here until the session Lambda finishes the call. Visibility
    // must cover the Lambda timeout; repeated failures land in the DLQ.
    const sessionDlq = new sqs.Queue(this, 'SessionDlq', { retentionPeriod: cdk.Duration.days(14) });
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
      LEADS_TABLE: this.leadsTable.tableName,
      EVENT_BUS_NAME: this.bus.eventBusName,
      EVENT_SOURCE,
      OPENAI_SECRET_ARN: this.openaiSecret.secretArn,
      CRM_SECRET_PREFIX: crmSecretPrefix,
      NODE_OPTIONS: '--enable-source-maps',
      LOG_LEVEL: 'info',
    };

    const fn = (id: string, entryFile: string, opts: { description: string; timeout: cdk.Duration; env?: Record<string, string> }) => {
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
    webhookFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [crmSecretArnPattern] }));

    const sessionFn = fn('session', 'session.ts', {
      description: 'Holds the OpenAI Realtime WebSocket for one call and runs the tool loop',
      timeout: cdk.Duration.seconds(900),
      env: props.gateway
        ? {
            GATEWAY_URL: props.gateway.gatewayUrl,
            COGNITO_USER_POOL_ID: props.gateway.userPoolId,
            COGNITO_CLIENT_ID: props.gateway.clientId,
            COGNITO_TOKEN_URL: props.gateway.tokenUrl,
          }
        : {},
    });
    if (props.gateway) {
      sessionFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:DescribeUserPoolClient'],
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.gateway.userPoolId}`],
      }));
    }
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
    this.leadsTable.grantWriteData(sessionFn);
    this.bus.grantPutEventsTo(sessionFn);
    sessionFn.addEventSource(new SqsEventSource(sessionQueue, {
      batchSize: 1, // one call per invocation
      reportBatchItemFailures: true,
      maxConcurrency: sessionMaxConcurrency,
    }));

    const notifierFn = fn('notifier', 'notifier.ts', {
      description: 'Turns lead.recorded / owner.notify events into email + SMS',
      timeout: cdk.Duration.seconds(30),
      env: { SES_FROM_EMAIL: sesFromEmail },
    });
    this.tenantsTable.grantReadData(notifierFn);
    notifierFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] }));
    // Direct-to-number SMS has no resource ARN to scope to.
    notifierFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['sns:Publish'], resources: ['*'] }));

    const crmSyncFn = fn('crm-sync', 'crm-sync.ts', {
      description: 'Syncs leads and call transcripts into the tenant CRM (HubSpot)',
      timeout: cdk.Duration.seconds(30),
    });
    this.tenantsTable.grantReadData(crmSyncFn);
    crmSyncFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [crmSecretArnPattern] }));

    // Gateway Lambda target: the voice tools as shared platform tools. Lives in
    // this stack (it owns the tables and bus); the gateway stack registers it.
    this.gatewayToolsFn = new NodejsFunction(this, 'gateway-tools', {
      functionName: `${prefix}-gateway-tools`,
      description: 'Gateway Lambda target: record_lead + notify_owner',
      entry: path.resolve(here, '../../lambda/src/tools.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(15),
      environment: {
        LEADS_TABLE: this.leadsTable.tableName,
        EVENT_BUS_NAME: this.bus.eventBusName,
        EVENT_SOURCE,
        LOG_LEVEL: 'info',
      },
      bundling: { format: OutputFormat.ESM, target: 'node22', banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    });
    this.leadsTable.grantWriteData(this.gatewayToolsFn);
    this.bus.grantPutEventsTo(this.gatewayToolsFn);

    // ---- Event routing --------------------------------------------------------

    new events.Rule(this, 'NotifyRule', {
      eventBus: this.bus,
      description: 'Route lead + owner notifications to the notifier',
      eventPattern: { source: [EVENT_SOURCE], detailType: ['lead.recorded', 'owner.notify'] },
      targets: [new targets.LambdaFunction(notifierFn, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1) })],
    });
    new events.Rule(this, 'CrmRule', {
      eventBus: this.bus,
      description: 'Route leads + call transcripts to the CRM sync',
      eventPattern: { source: [EVENT_SOURCE], detailType: ['lead.recorded', 'call.ended'] },
      targets: [new targets.LambdaFunction(crmSyncFn, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1) })],
    });

    // ---- HTTP API -------------------------------------------------------------

    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `${prefix}-api`,
      description: 'OpenAI webhook receiver',
    });
    api.addRoutes({
      path: '/openai/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // ---- Outputs --------------------------------------------------------------

    /** Register this for `realtime.call.incoming` at platform.openai.com -> Settings -> Webhooks. */
    new cdk.CfnOutput(this, 'webhookUrl', { value: `${api.apiEndpoint}/openai/webhook` });
    new cdk.CfnOutput(this, 'openaiSecretArn', { value: this.openaiSecret.secretArn });
    new cdk.CfnOutput(this, 'tenantsTableName', { value: this.tenantsTable.tableName });
    new cdk.CfnOutput(this, 'callsTableName', { value: this.callsTable.tableName });
    new cdk.CfnOutput(this, 'leadsTableName', { value: this.leadsTable.tableName });
    new cdk.CfnOutput(this, 'eventBusName', { value: this.bus.eventBusName });
    new cdk.CfnOutput(this, 'sessionQueueUrl', { value: sessionQueue.queueUrl });
    new cdk.CfnOutput(this, 'sessionFunctionName', { value: sessionFn.functionName });
    new cdk.CfnOutput(this, 'crmSecretNamePrefix', { value: crmSecretPrefix });
  }
}
