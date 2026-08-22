import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { bundleHandler, bundleWorker } from './bundle.js';

/**
 * API Gateway (HTTP) -> webhook Lambda -> [accept call] -> SQS -> EC2 worker (WebSocket to OpenAI)
 * DynamoDB: tenants (by called number), calls, leads. Secrets Manager: OpenAI keys.
 * EventBridge bus: lead.recorded / owner.notify / call.ended -> notifier Lambda (SES/SNS).
 */

const cfg = new pulumi.Config();
const sesFromEmail = cfg.get('sesFromEmail') ?? '';
const retainData = cfg.getBoolean('retainData') ?? true;
const workerInstanceType = cfg.get('workerInstanceType') ?? 't4g.nano';
const workerMaxCalls = cfg.getNumber('workerMaxCalls') ?? 20;

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

// Call jobs wait here until the worker finishes the call. A message that is
// received 5 times without being deleted (worker crashing on it) goes to the DLQ.
const sessionDlq = new aws.sqs.Queue('session-dlq', { messageRetentionSeconds: 14 * 86400 });
const sessionQueue = new aws.sqs.Queue('session-queue', {
  visibilityTimeoutSeconds: 90,
  messageRetentionSeconds: 3600, // a call older than an hour is over
  receiveWaitTimeSeconds: 20,
  redrivePolicy: sessionDlq.arn.apply((arn) => JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 })),
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

// ---- Session worker (EC2) ---------------------------------------------------
//
// One small Graviton instance runs src/worker/main.ts under systemd. It only makes
// outbound connections (SQS, OpenAI, DynamoDB), so the security group has no
// inbound rules; use SSM Session Manager for a shell. `pulumi up` uploads a new
// bundle and replaces the instance (user data changes); in-flight calls are
// re-attached by the new instance via the queue.

const artifacts = new aws.s3.Bucket('artifacts', { forceDestroy: true });
new aws.s3.BucketPublicAccessBlock('artifacts-private', {
  bucket: artifacts.id,
  blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true,
});
const workerBundlePath = bundleWorker();
const workerBundle = new aws.s3.BucketObject('worker-bundle', {
  bucket: artifacts.id,
  key: 'worker/index.mjs',
  source: new pulumi.asset.FileAsset(workerBundlePath),
  sourceHash: pulumi.output(workerBundlePath).apply(async (p) => {
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    return createHash('sha256').update(await readFile(p)).digest('hex');
  }),
});

const workerLogGroup = new aws.cloudwatch.LogGroup('worker-logs', {
  name: `/${name}/worker`,
  retentionInDays: 30,
});

const workerRole = new aws.iam.Role('worker-role', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ec2.amazonaws.com' }),
});
new aws.iam.RolePolicyAttachment('worker-ssm', { role: workerRole.name, policyArn: aws.iam.ManagedPolicy.AmazonSSMManagedInstanceCore });
new aws.iam.RolePolicyAttachment('worker-cwagent', { role: workerRole.name, policyArn: aws.iam.ManagedPolicy.CloudWatchAgentServerPolicy });
new aws.iam.RolePolicy('worker-policy', {
  role: workerRole.id,
  policy: aws.iam.getPolicyDocumentOutput({
    statements: [
      { actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'], resources: [sessionQueue.arn] },
      { actions: ['secretsmanager:GetSecretValue'], resources: [openaiSecret.arn] },
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [tenants.arn] },
      { actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], resources: [calls.arn] },
      { actions: ['dynamodb:PutItem'], resources: [leads.arn] },
      { actions: ['events:PutEvents'], resources: [bus.arn] },
      { actions: ['s3:GetObject'], resources: [pulumi.interpolate`${artifacts.arn}/worker/*`] },
    ],
  }).json,
});
const workerProfile = new aws.iam.InstanceProfile('worker-profile', { role: workerRole.name });

const defaultVpc = aws.ec2.getVpcOutput({ default: true });
const defaultSubnets = aws.ec2.getSubnetsOutput({ filters: [{ name: 'vpc-id', values: [defaultVpc.id] }, { name: 'default-for-az', values: ['true'] }] });
const workerSg = new aws.ec2.SecurityGroup('worker-sg', {
  vpcId: defaultVpc.id,
  description: 'Session worker: outbound only',
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'], ipv6CidrBlocks: ['::/0'] }],
});

const al2023Arm = aws.ssm.getParameterOutput({ name: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64' });

const workerEnv = pulumi.all([tenants.name, calls.name, leads.name, bus.name, openaiSecret.arn, sessionQueue.url, region]).apply(
  ([t, c, l, b, secretArn, queueUrl, r]) => [
    `AWS_REGION=${r}`,
    `TENANTS_TABLE=${t}`,
    `CALLS_TABLE=${c}`,
    `LEADS_TABLE=${l}`,
    `EVENT_BUS_NAME=${b}`,
    `EVENT_SOURCE=${EVENT_SOURCE}`,
    `OPENAI_SECRET_ARN=${secretArn}`,
    `SESSION_QUEUE_URL=${queueUrl}`,
    `WORKER_MAX_CALLS=${workerMaxCalls}`,
    `LOG_LEVEL=info`,
  ].join('\n'),
);

const userData = pulumi.all([artifacts.bucket, workerBundle.key, workerBundle.sourceHash, workerEnv, workerLogGroup.name]).apply(
  ([bucket, key, hash, envFile, logGroup]) => `#!/bin/bash
set -euxo pipefail
# bundle sha256: ${hash}
# 512 MB instances have no swap; dnf parsing AL2023 repo metadata can get OOM-killed without it.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
for attempt in 1 2 3; do
  dnf install -y --setopt=install_weak_deps=False nodejs22 amazon-cloudwatch-agent && break
  echo "dnf attempt $attempt failed; retrying" && sleep 10
done
command -v node
mkdir -p /opt/wnkinc-voice /etc/wnkinc-voice /var/log/wnkinc-voice
aws s3 cp "s3://${bucket}/${key}" /opt/wnkinc-voice/index.mjs
cat > /etc/wnkinc-voice/worker.env <<'ENV'
${envFile}
ENV
id -u voice >/dev/null 2>&1 || useradd --system --shell /sbin/nologin voice
chown -R voice:voice /opt/wnkinc-voice /var/log/wnkinc-voice
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/wnkinc-voice-worker.service <<UNIT
[Unit]
Description=wnkinc voice session worker
After=network-online.target
Wants=network-online.target

[Service]
User=voice
EnvironmentFile=/etc/wnkinc-voice/worker.env
ExecStart=$NODE_BIN --enable-source-maps /opt/wnkinc-voice/index.mjs
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=60
StandardOutput=append:/var/log/wnkinc-voice/worker.log
StandardError=append:/var/log/wnkinc-voice/worker.log

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/wnkinc-voice/cwagent.json <<'CW'
{"logs":{"logs_collected":{"files":{"collect_list":[{"file_path":"/var/log/wnkinc-voice/worker.log","log_group_name":"${logGroup}","log_stream_name":"{instance_id}","timezone":"UTC"}]}}}}
CW
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/etc/wnkinc-voice/cwagent.json -s
systemctl daemon-reload
systemctl enable --now wnkinc-voice-worker
`,
);

const worker = new aws.ec2.Instance('worker', {
  ami: al2023Arm.value,
  instanceType: workerInstanceType,
  subnetId: defaultSubnets.ids[0],
  vpcSecurityGroupIds: [workerSg.id],
  iamInstanceProfile: workerProfile.name,
  associatePublicIpAddress: true, // outbound internet without a NAT gateway
  userData,
  userDataReplaceOnChange: true,
  rootBlockDevice: { volumeType: 'gp3', volumeSize: 8, encrypted: true },
  metadataOptions: { httpTokens: 'required' }, // IMDSv2 only
  tags: { Name: `${name}-worker` },
}, { ignoreChanges: ['ami'] /* don't replace on every AL2023 release; bump deliberately */ });

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
export const workerInstanceId = worker.id;
export const workerLogGroupName = workerLogGroup.name;
export const crmSecretNamePrefix = crmSecretPrefix;
