/**
 * The platform: what every other stack builds on and every tenant shares.
 * Data and the bus, nothing that runs. The tables, the event bus, the HTTP
 * API the front doors add their routes to, the alarm topic every alarm
 * pages, the two platform secrets (OpenAI, Composio), and the activity log.
 * It changes rarely; the layers above it (receptionist, worker, a tenant)
 * change often and take these as handles.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/** The source every platform event is published under; rules in every stack match on it. */
export const EVENT_SOURCE = 'wnkinc.voice';

export interface PlatformStackProps extends cdk.StackProps {
  /** Every physical name starts with this, e.g. `wnk-dev`. */
  readonly prefix: string;
}

export class PlatformStack extends cdk.Stack {
  /** Per-business configuration, keyed by the called phone number. */
  readonly tenantsTable: dynamodb.Table;
  /** Channel identity -> tenant + person: `telegram:<id>` or `sms:<e164>`. Seeded from each tenant's `people`. */
  readonly peopleTable: dynamodb.Table;
  /** One row per call: transcript, status, the once-markers the automations write. */
  readonly callsTable: dynamodb.Table;
  /** Usage metering records: (tenantId, timestamp#meter) -> units. */
  readonly usageTable: dynamodb.Table;
  /** The approval ledger (@wnk/shared ActionSchema): one row per action that reaches a customer irreversibly, kept as the log. */
  readonly actionsTable: dynamodb.Table;
  readonly bus: events.EventBus;
  /** Every alarm in every stack pages this topic. */
  readonly alarmTopic: sns.Topic;
  /** The platform's HTTP API; the receptionist and the worker add their own routes to it. */
  readonly api: apigwv2.HttpApi;
  readonly openaiSecret: secretsmanager.Secret;
  /** Composio project API key ({"COMPOSIO_API_KEY": ...}): the SaaS credential broker every tenant's Gmail/HubSpot goes through. */
  readonly composioSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // ---- Secrets: created with placeholders, the values put in by hand (README) ----
    this.openaiSecret = new secretsmanager.Secret(this, 'OpenAISecret', {
      description: 'OpenAI API key + webhook signing secret for the voice receptionist',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ OPENAI_API_KEY: 'REPLACE_ME', OPENAI_WEBHOOK_SECRET: 'REPLACE_ME' }),
        generateStringKey: '_placeholder',
      },
    });
    // Composio: Gmail + HubSpot credential broker (their verified OAuth apps;
    // tokens in their vault keyed by our tenant id). Fill after deploy:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"COMPOSIO_API_KEY":"ak_..."}'
    this.composioSecret = new secretsmanager.Secret(this, 'ComposioSecret', {
      description: 'Composio project API key ({"COMPOSIO_API_KEY": ...})',
    });

    // ---- Tables ------------------------------------------------------------------
    this.tenantsTable = new dynamodb.Table(this, 'Tenants', {
      partitionKey: { name: 'phoneNumber', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // a dev stage; flip to RETAIN for real data
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
    // tenantId, then `<approver channel id>#<type>#<created>#<id>`: a person's
    // pending action of a type is one Query, and no row is ever overwritten.
    // RETAIN, unlike the dev tables: this is the record of who approved what.
    this.actionsTable = new dynamodb.Table(this, 'Actions', {
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- The bus, the alarm topic, the API ------------------------------------------
    this.bus = new events.EventBus(this, 'Events', { eventBusName: `${prefix}-events` });

    // One topic for every alarm on the platform. Who it pages is operator data,
    // not code: subscribe on the topic itself (`aws sns subscribe`, or the
    // console). Kept out of the template deliberately: a subscription CDK owns
    // is one a deploy without the variable set would silently delete, and the
    // failure mode of alerting is silence, which looks exactly like health.
    this.alarmTopic = new sns.Topic(this, 'Alarms', { topicName: `${prefix}-alarms`, displayName: 'WNK platform alarms' });

    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `${prefix}-api`,
      description: 'Platform webhooks: OpenAI Realtime (receptionist stack), Telegram and Twilio (worker stack)',
    });

    // ---- The activity log ---------------------------------------------------------
    // Every consumer of lead.recorded / owner.notify / call.ended is a workflow
    // on the worker; the rules live in the worker stack and each tenant's stack.
    // Except this one: every event lands in one log group as the platform's
    // activity record. Nothing else retains bus events. It is per tenant by
    // construction (each event carries detail.tenantId) and keeps the same
    // 90-day window as the Calls row TTL, so both stores answer "what happened
    // for tenant X" over the same period.
    const activityLog = new logs.LogGroup(this, 'ActivityLog', {
      logGroupName: `/${prefix}/activity`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new events.Rule(this, 'ActivityLogRule', {
      eventBus: this.bus,
      description: 'Record every platform event in the activity log group',
      eventPattern: { source: [EVENT_SOURCE] },
      targets: [new targets.CloudWatchLogGroup(activityLog)],
    });

    // ---- Outputs ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'openaiSecretArn', { value: this.openaiSecret.secretArn });
    new cdk.CfnOutput(this, 'composioSecretArn', { value: this.composioSecret.secretArn });
    new cdk.CfnOutput(this, 'apiEndpoint', { value: this.api.apiEndpoint });
    new cdk.CfnOutput(this, 'tenantsTableName', { value: this.tenantsTable.tableName });
    new cdk.CfnOutput(this, 'peopleTableName', { value: this.peopleTable.tableName });
    new cdk.CfnOutput(this, 'callsTableName', { value: this.callsTable.tableName });
    new cdk.CfnOutput(this, 'actionsTableName', { value: this.actionsTable.tableName });
    new cdk.CfnOutput(this, 'eventBusName', { value: this.bus.eventBusName });
    /** Subscribe an address here once; no deploy touches the subscribers. */
    new cdk.CfnOutput(this, 'alarmTopicArn', { value: this.alarmTopic.topicArn });
  }
}
