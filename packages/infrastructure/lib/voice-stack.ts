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
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { dlqAlarm, errorAlarm, failedExecutionsAlarm } from './alarms.js';
import { COMPOSIO_API, OPENAI_API, expressNoData, grantHttp, htmlToTextExpr, httpTask, q, sipNumberExpr, SIP_CALLED_HEADERS, SIP_CALLER_HEADERS, strOrEmpty } from './workflows.js';
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
      description: 'Holds the OpenAI Realtime WebSocket for one call and runs the tool loop',
      timeout: cdk.Duration.seconds(900),
    });
    sessionFn.addEnvironment('USAGE_TABLE', this.usageTable.tableName);
    this.usageTable.grantWriteData(sessionFn);
    if (props.callerMemory) {
      for (const f of [sessionFn]) {
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

    // Composio: Gmail + HubSpot credential broker (their verified OAuth apps;
    // tokens in their vault keyed by our tenant id). Fill after deploy:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"COMPOSIO_API_KEY":"ak_..."}'
    this.composioSecret = new secretsmanager.Secret(this, 'ComposioSecret', {
      description: 'Composio project API key ({"COMPOSIO_API_KEY": ...})',
    });
    // ---- Accept workflow: verified webhook -> tenant -> claim -> accept -> recognize -> enqueue
    //
    // Express, execution data not logged (SIP headers, phone numbers, the
    // caller's last CRM note). The verifier Lambda starts it with the webhook
    // body. Called number -> tenant row is the ONLY place the tenant is chosen:
    // unknown number rejects 404 and fails (alarm: a routing problem); inactive
    // tenant rejects 603 and succeeds. The claim is a conditional put, so a
    // re-posted webhook ends as a duplicate. Accept carries the minimum (the
    // session Lambda re-sends the full agent config when it attaches); caller
    // recognition then runs with a real time budget and rides to the session
    // on the queue message. The API keys ride in EventBridge Connections
    // (resolved from the secrets at deploy: rotate a key, redeploy).
    this.composioConnection = new events.Connection(this, 'ComposioConnection', {
      description: 'Composio API key for the platform workflows (voice + runtime stacks)',
      authorization: events.Authorization.apiKey('x-api-key', this.composioSecret.secretValueFromJson('COMPOSIO_API_KEY')),
    });
    const openaiConnection = new events.Connection(this, 'OpenAIConnection', {
      description: 'OpenAI API key for the accept workflow',
      authorization: events.Authorization.apiKey('Authorization', cdk.SecretValue.unsafePlainText(`Bearer ${this.openaiSecret.secretValueFromJson('OPENAI_API_KEY').unsafeUnwrap()}`)),
    });
    const composioHttp = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query?: Record<string, string>) =>
      httpTask(this.composioConnection, method, COMPOSIO_API + path, body, query);
    const callUrl = (action: 'accept' | 'reject') => q(`'${OPENAI_API}realtime/calls/' & $callId & '/${action}'`);
    const tenantId = q('$tenant.tenantId.S');
    const callKey = { TableName: this.callsTable.tableName, Key: { callId: { S: q('$callId') } } };
    const setStatus = (status: string, error?: string) => ({
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
      Arguments: {
        ...callKey,
        UpdateExpression: error ? 'SET #s = :s, #e = :e' : 'SET #s = :s',
        ExpressionAttributeNames: { '#s': 'status', ...(error ? { '#e': 'error' } : {}) },
        ExpressionAttributeValues: { ':s': { S: status }, ...(error ? { ':e': { S: error } } : {}) },
      },
      Output: q('$states.input'),
    });
    const name = `$trim(${strOrEmpty('$contact.properties.firstname')} & ' ' & ${strOrEmpty('$contact.properties.lastname')})`;
    const sessionJob = [
      '$string($merge([',
      "{'callId': $callId, 'tenantPhoneNumber': $tenant.phoneNumber.S, 'startedAt': $startedAt, 'to': $to},",
      "($from != '' ? {'from': $from} : {}),",
      "{'extras': $merge([",
      "  ($from != '' ? {'callerPhone': $from} : {}),",
      `  ($exists($contact.id) ? {'knownCaller': $merge([{'contactId': $contact.id}, (${name} != '' ? {'name': ${name}} : {}),`,
      `    ($exists($note.hs_note_body) ? {'lastNote': ${htmlToTextExpr('$note.hs_note_body')}, 'lastNoteAt': $note.hs_createdate} : {})])} : {}),`,
      "  ($count($memories) > 0 ? {'callerMemory': $memories} : {})",
      '])}]))',
    ].join(' ');
    const acceptDefinition = {
      QueryLanguage: 'JSONata',
      StartAt: 'IsIncomingCall',
      States: {
        IsIncomingCall: { Type: 'Choice', Choices: [{ Condition: q("$states.input.type = 'realtime.call.incoming'"), Next: 'Parse' }], Default: 'Ignored' },
        Ignored: { Type: 'Succeed' },
        Parse: {
          Type: 'Pass',
          Assign: {
            callId: q('$states.input.data.call_id'),
            webhookId: q('$states.input.id'),
            startedAt: q('$now()'),
            to: q(sipNumberExpr('$states.input.data.sip_headers', SIP_CALLED_HEADERS)),
            from: q(sipNumberExpr('$states.input.data.sip_headers', SIP_CALLER_HEADERS)),
          },
          Output: q('$states.input'), Next: 'HasCalledNumber',
        },
        HasCalledNumber: { Type: 'Choice', Choices: [{ Condition: q("$to != ''"), Next: 'LookupTenant' }], Default: 'RejectUnknown' },
        LookupTenant: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
          Arguments: { TableName: this.tenantsTable.tableName, Key: { phoneNumber: { S: q('$to') } } },
          Assign: { tenant: q('$states.result.Item') }, Output: q('$states.input'), Next: 'TenantState',
        },
        TenantState: {
          Type: 'Choice',
          Choices: [
            { Condition: q('$not($exists($tenant))'), Next: 'RejectUnknown' },
            { Condition: q('$tenant.active.BOOL = false'), Next: 'RejectInactive' },
          ],
          Default: 'Claim',
        },
        RejectUnknown: {
          ...httpTask(openaiConnection, 'POST', callUrl('reject'), { status_code: 404 }),
          Catch: [{ ErrorEquals: ['States.ALL'], Next: 'UnknownCalledNumber' }],
          Next: 'UnknownCalledNumber',
        },
        UnknownCalledNumber: { Type: 'Fail', Error: 'UnknownCalledNumber', Cause: 'No tenant row for the called number; rejected with SIP 404. Check the Twilio trunk numbers against the Tenants table.' },
        RejectInactive: { ...httpTask(openaiConnection, 'POST', callUrl('reject'), { status_code: 603 }), Next: 'Rejected' },
        Rejected: { Type: 'Succeed' },
        // Idempotent across OpenAI's webhook retries; a call whose earlier attempt failed may be re-claimed.
        Claim: {
          Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
          Arguments: {
            TableName: this.callsTable.tableName,
            Item: q([
              "$merge([{'callId': {'S': $callId}, 'tenantId': {'S': $tenant.tenantId.S}, 'tenantPhoneNumber': {'S': $tenant.phoneNumber.S}, 'to': {'S': $to},",
              "'webhookId': {'S': $webhookId}, 'status': {'S': 'claimed'}, 'startedAt': {'S': $startedAt}, 'expiresAt': {'N': $string($floor($millis() / 1000) + 90 * 86400)}},",
              "($from != '' ? {'from': {'S': $from}} : {})])",
            ].join(' ')),
            ConditionExpression: 'attribute_not_exists(callId) OR #s = :failed',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':failed': { S: 'failed' } },
          },
          Catch: [{ ErrorEquals: ['DynamoDB.ConditionalCheckFailedException'], Next: 'Duplicate' }],
          Output: q('$states.input'), Next: 'Accept',
        },
        Duplicate: { Type: 'Succeed' },
        Accept: {
          ...httpTask(openaiConnection, 'POST', callUrl('accept'), {
            type: 'realtime',
            model: q('$tenant.model.S'),
            instructions: q("'You are ' & $tenant.agentName.S & ', the phone receptionist for ' & $tenant.businessName.S & '. The call has just connected and the receptionist system will start the conversation in a moment. Until you receive new instructions, do not speak.'"),
            audio: { output: { voice: q('$tenant.voice.S') } },
          }),
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'MarkFailed' }],
          Output: q('$states.input'), Next: 'MarkAccepted',
        },
        MarkFailed: { ...setStatus('failed', 'accept failed'), Next: 'AcceptFailed' },
        AcceptFailed: { Type: 'Fail', Error: 'AcceptFailed', Cause: 'OpenAI did not accept the call (gone, or an API error); the call row is marked failed' },
        MarkAccepted: { ...setStatus('accepted'), Next: 'HasCrm' },
        // ---- Caller recognition, best effort: the tenant's CRM, then memory ----
        HasCrm: {
          Type: 'Choice',
          Choices: [{ Condition: q("$from != '' and $tenant.crm.M.type.S = 'hubspot' and $tenant.crm.M.via.S = 'composio'"), Next: 'FindContact' }],
          Default: 'HasCaller',
        },
        FindContact: {
          ...composioHttp('POST', 'tools/execute/HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
            user_id: tenantId,
            arguments: {
              filterGroups: [
                { filters: [{ propertyName: 'phone', operator: 'EQ', value: q('$from') }] },
                { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: q('$from') }] },
              ],
              properties: ['firstname', 'lastname', 'phone'], limit: 1,
            },
          }),
          Assign: { contact: q('$states.result.ResponseBody.data.results[0]') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasCaller' }],
          Output: q('$states.input'), Next: 'HasContact',
        },
        HasContact: { Type: 'Choice', Choices: [{ Condition: q('$exists($contact.id)'), Next: 'HubspotAccount' }], Default: 'HasCaller' },
        HubspotAccount: {
          ...composioHttp('GET', 'connected_accounts', undefined, { user_ids: tenantId, toolkit_slugs: 'hubspot', statuses: 'ACTIVE' }),
          Assign: { accountId: q('$states.result.ResponseBody.items[0].id') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasCaller' }],
          Output: q('$states.input'), Next: 'LastNote',
        },
        LastNote: {
          ...composioHttp('POST', 'tools/execute/proxy', {
            endpoint: '/crm/v3/objects/notes/search', method: 'POST', connected_account_id: q('$accountId'),
            body: {
              filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: q('$contact.id') }] }],
              sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
              properties: ['hs_note_body', 'hs_timestamp'], limit: 1,
            },
          }),
          Assign: { note: q('$states.result.ResponseBody.data.results[0].properties') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'HasCaller' }],
          Output: q('$states.input'), Next: 'HasCaller',
        },
        HasCaller: { Type: 'Choice', Choices: [{ Condition: q("$from != ''"), Next: props.callerMemory ? 'RecallMemory' : 'Enqueue' }], Default: 'Enqueue' },
        ...(props.callerMemory ? { RecallMemory: {
          Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:retrieveMemoryRecords',
          Arguments: {
            MemoryId: props.callerMemory.memoryId,
            NamespacePath: q("'/callers/' & $tenant.tenantId.S & '_' & $replace($from, /[^0-9]/, '')"),
            SearchCriteria: { SearchQuery: 'who this caller is, their jobs, and their preferences', TopK: 6 },
          },
          Assign: { memories: q('[$states.result.MemoryRecordSummaries.Content.Text]') },
          Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'Enqueue' }],
          Output: q('$states.input'), Next: 'Enqueue',
        } } : {}),
        Enqueue: {
          Type: 'Task', Resource: 'arn:aws:states:::sqs:sendMessage',
          Arguments: { QueueUrl: sessionQueue.queueUrl, MessageBody: q(sessionJob) },
          End: true,
        },
      },
    };
    const acceptWorkflow = new sfn.StateMachine(this, 'AcceptWorkflow', {
      stateMachineName: `${prefix}-accept`,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(acceptDefinition)),
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

    // ---- Alarms ---------------------------------------------------------------
    // Two questions, answered by CloudWatch: is anything failing right now
    // (function errors), and did anything fail for good (dead-letter queues).

    dlqAlarm(this, 'SessionDlqAlarm', sessionDlq, this.alarmTopic, 'Voice: a call job failed 3 times');
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
    new cdk.CfnOutput(this, 'sessionQueueUrl', { value: sessionQueue.queueUrl });
    new cdk.CfnOutput(this, 'sessionFunctionName', { value: sessionFn.functionName });
  }
}
