import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { bundleHandler } from './bundle.js';

/**
 * API Gateway (HTTP) -> webhook Lambda -> [accept call] -> SQS -> session Lambda (WebSocket to OpenAI)
 * DynamoDB: tenants (by called number), calls, leads. Secrets Manager: OpenAI keys.
 * EventBridge bus: lead.recorded / owner.notify / call.ended -> notifier Lambda (SES/SNS).
 */

const cfg = new pulumi.Config();
const sesFromEmail = cfg.get('sesFromEmail') ?? '';
const retainData = cfg.getBoolean('retainData') ?? true;
// Ceiling on simultaneous calls (and therefore concurrent OpenAI Realtime sessions). SQS scaling config minimum is 2.
const sessionMaxConcurrency = cfg.getNumber('sessionMaxConcurrency') ?? 20;

const name = `${pulumi.getProject()}-${pulumi.getStack()}`;
const region = aws.getRegionOutput().region;
const EVENT_SOURCE = 'wnkinc.voice';

// ---- State ------------------------------------------------------------------

const openaiSecret = new aws.secretsmanager.Secret('openai', {
  namePrefix: `${name}/openai-`,
  description: 'OpenAI API key + webhook signing secret for the voice receptionist',
});
new aws.secretsmanager.SecretVersion('openai-placeholder', {
  secretId: openaiSecret.id,
  secretString: JSON.stringify({ OPENAI_API_KEY: 'REPLACE_ME', OPENAI_WEBHOOK_SECRET: 'REPLACE_ME' }),
}, {
  // Real values are written with `aws secretsmanager put-secret-value`; never let Pulumi revert them.
  ignoreChanges: ['secretString', 'versionStages'],
});

const tenants = new aws.dynamodb.Table('tenants', {
  billingMode: 'PAY_PER_REQUEST',
  hashKey: 'phoneNumber',
  attributes: [{ name: 'phoneNumber', type: 'S' }],
  pointInTimeRecovery: { enabled: retainData },
}, { protect: retainData });

const calls = new aws.dynamodb.Table('calls', {
  billingMode: 'PAY_PER_REQUEST',
  hashKey: 'callId',
  attributes: [
    { name: 'callId', type: 'S' },
    { name: 'tenantId', type: 'S' },
    { name: 'startedAt', type: 'S' },
  ],
  globalSecondaryIndexes: [{
    name: 'byTenant',
    keySchemas: [
      { attributeName: 'tenantId', keyType: 'HASH' },
      { attributeName: 'startedAt', keyType: 'RANGE' },
    ],
    projectionType: 'ALL',
  }],
  ttl: { attributeName: 'expiresAt', enabled: true },
});

const leads = new aws.dynamodb.Table('leads', {
  billingMode: 'PAY_PER_REQUEST',
  hashKey: 'tenantId',
  rangeKey: 'sk',
  attributes: [
    { name: 'tenantId', type: 'S' },
    { name: 'sk', type: 'S' },
  ],
  pointInTimeRecovery: { enabled: retainData },
}, { protect: retainData });

const bus = new aws.cloudwatch.EventBus('events', { name: `${name}-events` });

// Per-tenant CRM credentials: one secret per tenant at `${name}/crm/<tenantId>`.
// Create new tenants' secrets here (or by hand with the same naming); write the real
// token with `aws secretsmanager put-secret-value`.
const crmSecretPrefix = `${name}/crm/`;
const crmSecretArnPattern = pulumi.interpolate`arn:aws:secretsmanager:${region}:${aws.getCallerIdentityOutput().accountId}:secret:${crmSecretPrefix}*`;
for (const tenantId of ['wnk']) {
  new aws.secretsmanager.Secret(`crm-${tenantId}`, {
    name: `${crmSecretPrefix}${tenantId}`,
    description: `CRM credentials for tenant ${tenantId}`,
  });
  new aws.secretsmanager.SecretVersion(`crm-${tenantId}-placeholder`, {
    secretId: `${crmSecretPrefix}${tenantId}`,
    secretString: JSON.stringify({ HUBSPOT_TOKEN: 'REPLACE_ME' }),
  }, { ignoreChanges: ['secretString', 'versionStages'], dependsOn: [] });
}

// Call jobs wait here until the session Lambda finishes the call. Lambda requires the
// visibility timeout to be at least the function timeout; a reported batch failure
// makes the message visible again, and repeated failures go to the DLQ.
const sessionDlq = new aws.sqs.Queue('session-dlq', { messageRetentionSeconds: 14 * 86400 });
const sessionQueue = new aws.sqs.Queue('session-queue', {
  visibilityTimeoutSeconds: 960,
  messageRetentionSeconds: 3600, // a call older than an hour is over
  receiveWaitTimeSeconds: 20,
  redrivePolicy: sessionDlq.arn.apply((arn) => JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 3 })),
});

// ---- Lambda helper ----------------------------------------------------------

const commonEnv = {
  TENANTS_TABLE: tenants.name,
  CALLS_TABLE: calls.name,
  LEADS_TABLE: leads.name,
  EVENT_BUS_NAME: bus.name,
  EVENT_SOURCE,
  OPENAI_SECRET_ARN: openaiSecret.arn,
  CRM_SECRET_PREFIX: crmSecretPrefix,
  NODE_OPTIONS: '--enable-source-maps',
  LOG_LEVEL: 'info',
};

interface FnSpec {
  description: string;
  timeoutSeconds: number;
  env?: Record<string, pulumi.Input<string>>;
  statements: aws.types.input.iam.GetPolicyDocumentStatementArgs[];
}

function lambdaFunction(id: string, spec: FnSpec) {
  const fnName = `${name}-${id}`;

  const role = new aws.iam.Role(`${id}-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
  });
  const basic = new aws.iam.RolePolicyAttachment(`${id}-basic-exec`, {
    role: role.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
  });
  new aws.iam.RolePolicy(`${id}-policy`, {
    role: role.id,
    policy: aws.iam.getPolicyDocumentOutput({ statements: spec.statements }).json,
  });

  const logGroup = new aws.cloudwatch.LogGroup(`${id}-logs`, {
    name: `/aws/lambda/${fnName}`,
    retentionInDays: 30,
  });

  return new aws.lambda.Function(id, {
    name: fnName,
    description: spec.description,
    runtime: aws.lambda.Runtime.NodeJS22dX,
    architectures: ['arm64'],
    handler: 'index.handler',
    role: role.arn,
    code: new pulumi.asset.FileArchive(bundleHandler(id)),
    timeout: spec.timeoutSeconds,
    memorySize: 512,
    environment: { variables: { ...commonEnv, ...(spec.env ?? {}) } },
    loggingConfig: { logFormat: 'Text', logGroup: logGroup.name },
  }, { dependsOn: [basic, logGroup] });
}

// ---- Lambdas ----------------------------------------------------------------

const webhookFn = lambdaFunction('webhook', {
  description: 'Verifies OpenAI realtime.call.incoming webhooks, routes to a tenant, accepts the call',
  timeoutSeconds: 15,
  env: { SESSION_QUEUE_URL: sessionQueue.url },
  statements: [
    { actions: ['secretsmanager:GetSecretValue'], resources: [openaiSecret.arn] },
    { actions: ['dynamodb:GetItem'], resources: [tenants.arn] },
    { actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], resources: [calls.arn] },
    { actions: ['sqs:SendMessage'], resources: [sessionQueue.arn] },
    { actions: ['secretsmanager:GetSecretValue'], resources: [crmSecretArnPattern] },
  ],
});

const crmSyncFn = lambdaFunction('crm-sync', {
  description: 'Syncs leads and call transcripts into the tenant CRM (HubSpot)',
  timeoutSeconds: 30,
  statements: [
    { actions: ['dynamodb:GetItem'], resources: [tenants.arn] },
    { actions: ['secretsmanager:GetSecretValue'], resources: [crmSecretArnPattern] },
  ],
});

const notifierFn = lambdaFunction('notifier', {
  description: 'Turns lead.recorded / owner.notify events into email + SMS',
  timeoutSeconds: 30,
  env: { SES_FROM_EMAIL: sesFromEmail },
  statements: [
    { actions: ['dynamodb:GetItem'], resources: [tenants.arn] },
    { actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] },
    // Direct-to-number SMS has no resource ARN to scope to.
    { actions: ['sns:Publish'], resources: ['*'] },
  ],
});

// ---- Session Lambda ---------------------------------------------------------
//
// One invocation per call: attaches the WebSocket to OpenAI and runs the call to
// completion. Lambda's 15-minute cap is the hard ceiling on call length; the
// tenant schema caps maxCallSeconds at 840 to leave wrap-up headroom.

const sessionFn = lambdaFunction('session', {
  description: 'Holds the OpenAI Realtime WebSocket for one call and runs the tool loop',
  timeoutSeconds: 900,
  statements: [
    { actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'], resources: [sessionQueue.arn] },
    { actions: ['secretsmanager:GetSecretValue'], resources: [openaiSecret.arn] },
    { actions: ['dynamodb:GetItem'], resources: [tenants.arn] },
    { actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], resources: [calls.arn] },
    { actions: ['dynamodb:PutItem'], resources: [leads.arn] },
    { actions: ['events:PutEvents'], resources: [bus.arn] },
  ],
});
new aws.lambda.EventSourceMapping('session-source', {
  eventSourceArn: sessionQueue.arn,
  functionName: sessionFn.arn,
  batchSize: 1, // one call per invocation
  functionResponseTypes: ['ReportBatchItemFailures'],
  scalingConfig: { maximumConcurrency: sessionMaxConcurrency },
});

// ---- Event routing ----------------------------------------------------------

const notifyRule = new aws.cloudwatch.EventRule('notify-rule', {
  eventBusName: bus.name,
  description: 'Route lead + owner notifications to the notifier',
  eventPattern: JSON.stringify({ source: [EVENT_SOURCE], 'detail-type': ['lead.recorded', 'owner.notify'] }),
});
new aws.cloudwatch.EventTarget('notify-target', {
  eventBusName: bus.name,
  rule: notifyRule.name,
  arn: notifierFn.arn,
  retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
});
new aws.lambda.Permission('notify-rule-invoke', {
  action: 'lambda:InvokeFunction',
  function: notifierFn.name,
  principal: 'events.amazonaws.com',
  sourceArn: notifyRule.arn,
});

const crmRule = new aws.cloudwatch.EventRule('crm-rule', {
  eventBusName: bus.name,
  description: 'Route leads + call transcripts to the CRM sync',
  eventPattern: JSON.stringify({ source: [EVENT_SOURCE], 'detail-type': ['lead.recorded', 'call.ended'] }),
});
new aws.cloudwatch.EventTarget('crm-target', {
  eventBusName: bus.name,
  rule: crmRule.name,
  arn: crmSyncFn.arn,
  retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
});
new aws.lambda.Permission('crm-rule-invoke', {
  action: 'lambda:InvokeFunction',
  function: crmSyncFn.name,
  principal: 'events.amazonaws.com',
  sourceArn: crmRule.arn,
});

// ---- HTTP API ---------------------------------------------------------------

const api = new aws.apigatewayv2.Api('api', {
  name: `${name}-api`,
  protocolType: 'HTTP',
  description: 'OpenAI webhook receiver',
});
const integration = new aws.apigatewayv2.Integration('webhook-integration', {
  apiId: api.id,
  integrationType: 'AWS_PROXY',
  integrationUri: webhookFn.invokeArn,
  payloadFormatVersion: '2.0',
});
new aws.apigatewayv2.Route('webhook-route', {
  apiId: api.id,
  routeKey: 'POST /openai/webhook',
  target: pulumi.interpolate`integrations/${integration.id}`,
});
new aws.apigatewayv2.Stage('default-stage', {
  apiId: api.id,
  name: '$default',
  autoDeploy: true,
});
new aws.lambda.Permission('api-invoke', {
  action: 'lambda:InvokeFunction',
  function: webhookFn.name,
  principal: 'apigateway.amazonaws.com',
  sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
});

// ---- Outputs ----------------------------------------------------------------

/** Register this for `realtime.call.incoming` at platform.openai.com -> Settings -> Webhooks. */
export const webhookUrl = pulumi.interpolate`${api.apiEndpoint}/openai/webhook`;
export const openaiSecretArn = openaiSecret.arn;
export const tenantsTableName = tenants.name;
export const callsTableName = calls.name;
export const leadsTableName = leads.name;
export const eventBusName = bus.name;
export const sessionQueueUrl = sessionQueue.url;
export const sessionFunctionName = sessionFn.name;
export const crmSecretNamePrefix = crmSecretPrefix;
