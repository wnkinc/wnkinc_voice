import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { dlqAlarm, errorAlarm } from './alarms.js';
import { Construct } from 'constructs';
import { buildSync } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly gatewayUrl: string;
  readonly cognitoUserPoolId: string;
  readonly cognitoClientId: string;
  readonly cognitoTokenUrl: string;
  readonly workloadName: string;
  readonly googleProviderName: string;
  readonly openaiSecret: secretsmanager.ISecret;
  readonly bus: events.IEventBus;
  readonly usageTable: dynamodb.ITable;
  /** Agents read their tenant's row to check the service is enabled and how it is configured. */
  readonly tenantsTable: dynamodb.ITable;
  /** Once-markers for "already emailed this lead" live on the call row. */
  readonly callsTable: dynamodb.ITable;
  readonly alarmTopic: sns.ITopic;
  /** Caller memory: the email agent recalls facts about the lead's caller. */
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * Agents hosted on AgentCore Runtime. The email responder is bundled with
 * esbuild (single index.mjs, no Docker) and runs on the managed NODE_22
 * runtime; an EventBridge rule + small trigger Lambda invoke it per lead.
 */
export class RuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // Bundle an agent at synth time, same pattern NodejsFunction uses for
    // Lambdas. CJS + .js: the managed NODE_22 runtime requires a .js entrypoint,
    // and CJS sidesteps type:module ambiguity; the package.json pins that, and
    // the banner shims import.meta.url (undefined under CJS) for deps.
    const bundleAgent = (name: string): string => {
      const dist = path.resolve(here, `../.build/${name}`);
      rmSync(dist, { recursive: true, force: true });
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'commonjs' }));
      buildSync({
        entryPoints: [path.resolve(here, `../../${name}/src/agent.ts`)],
        outfile: path.join(dist, 'index.js'),
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        sourcemap: false,
        logLevel: 'warning',
        define: { 'import.meta.url': '__importMetaUrl' },
        banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
      });
      return dist;
    };
    const dist = bundleAgent('email-responder');

    // Composio: Gmail credential broker (their verified OAuth app; no 7-day
    // token expiry). Fill after deploy:
    //   aws secretsmanager put-secret-value --secret-id <arn> \
    //     --secret-string '{"COMPOSIO_API_KEY":"ak_..."}'
    // Which broker a tenant uses is tenant data: `products.emailResponder.via`.
    const composioSecret = new secretsmanager.Secret(this, 'ComposioSecret', {
      description: 'Composio project API key ({"COMPOSIO_API_KEY": ...})',
    });

    const emailAgent = new agentcore.Runtime(this, 'EmailResponder', {
      runtimeName: `${prefix.replace(/-/g, '_')}_email_responder`,
      description: 'Drafts and sends the owner a follow-up email for each recorded lead',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: dist,
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ['index.js'], // managed NODE_22 runs the file itself; no interpreter prefix
      }),
      environmentVariables: {
        GATEWAY_URL: props.gatewayUrl,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        COGNITO_TOKEN_URL: props.cognitoTokenUrl,
        WORKLOAD_NAME: props.workloadName,
        GOOGLE_PROVIDER_NAME: props.googleProviderName,
        OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
        USAGE_TABLE: props.usageTable.tableName,
        TENANTS_TABLE: props.tenantsTable.tableName,
        CALLS_TABLE: props.callsTable.tableName,
        COMPOSIO_SECRET_ARN: composioSecret.secretArn,
        ...(props.callerMemory ? { MEMORY_ID: props.callerMemory.memoryId } : {}),
      },
    });
    composioSecret.grantRead(emailAgent.role);
    props.tenantsTable.grantReadData(emailAgent.role);
    props.callsTable.grantReadWriteData(emailAgent.role);
    new cdk.CfnOutput(this, 'composioSecretArn', { value: composioSecret.secretArn });

    // The agent's own credentials: read the vault token for its workload, read
    // the OpenAI key, and read the Cognito client secret for Gateway JWTs.
    const agentcoreArn = (resource: string) => `arn:aws:bedrock-agentcore:${this.region}:${this.account}:${resource}`;
    emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessTokenForUserId', 'bedrock-agentcore:GetResourceOauth2Token'],
      resources: [
        agentcoreArn('workload-identity-directory/default'),
        agentcoreArn(`workload-identity-directory/default/workload-identity/${props.workloadName}`),
        agentcoreArn('token-vault/default'),
        agentcoreArn('token-vault/default/oauth2credentialprovider/*'),
      ],
    }));
    emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!*`],
    }));
    props.openaiSecret.grantRead(emailAgent.role);
    props.usageTable.grantWriteData(emailAgent.role);
    if (props.callerMemory) {
      emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: MEMORY_USE_ACTIONS,
        resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
      }));
    }
    emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:DescribeUserPoolClient'],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`],
    }));

    // lead.recorded -> trigger Lambda -> InvokeAgentRuntime. The trigger throws
    // on an agent failure, so Lambda retries it twice and then parks the event
    // here; the alarm on this queue is how a lost lead email gets noticed.
    const triggerDlq = new sqs.Queue(this, 'EmailTriggerDlq', { retentionPeriod: cdk.Duration.days(14) });
    const triggerFn = new NodejsFunction(this, 'EmailTrigger', {
      functionName: `${prefix}-email-trigger`,
      description: 'Invokes the email responder runtime for each lead.recorded event',
      entry: path.resolve(here, '../../email-responder/src/trigger.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      environment: { EMAIL_AGENT_RUNTIME_ARN: emailAgent.agentRuntimeArn },
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: triggerDlq,
      bundling: { format: OutputFormat.ESM, target: 'node22' },
    });
    triggerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [emailAgent.agentRuntimeArn, `${emailAgent.agentRuntimeArn}/runtime-endpoint/*`],
    }));
    new events.Rule(this, 'LeadRule', {
      eventBus: props.bus,
      description: 'Route lead.recorded to the email responder agent',
      eventPattern: { source: ['wnkinc.voice'], detailType: ['lead.recorded'] },
      targets: [new targets.LambdaFunction(triggerFn, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: triggerDlq })],
    });
    dlqAlarm(this, 'EmailTriggerDlqAlarm', triggerDlq, props.alarmTopic, 'Email responder: a lead email was not sent after retries');
    errorAlarm(this, 'EmailTriggerErrors', triggerFn, props.alarmTopic, 'Email responder trigger');

    // ---- Back-office agent: Runtime + AgentCore Browser -----------------------

    const browser = new agentcore.BrowserCustom(this, 'Browser', {
      browserCustomName: `${prefix.replace(/-/g, '_')}_browser`,
      description: 'Managed browser for back-office research tasks',
      networkConfiguration: agentcore.BrowserNetworkConfiguration.usingPublicNetwork(),
    });

    const backOffice = new agentcore.Runtime(this, 'BackOffice', {
      runtimeName: `${prefix.replace(/-/g, '_')}_back_office`,
      description: 'Research tasks: drives an AgentCore Browser session and answers questions from pages',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: bundleAgent('back-office'),
        runtime: agentcore.AgentCoreRuntime.NODE_22,
        entrypoint: ['index.js'],
      }),
      environmentVariables: {
        BROWSER_ID: browser.browserId,
        OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
        USAGE_TABLE: props.usageTable.tableName,
        TENANTS_TABLE: props.tenantsTable.tableName,
      },
    });
    browser.grantUse(backOffice.role);
    props.usageTable.grantWriteData(backOffice.role);
    props.tenantsTable.grantReadData(backOffice.role);
    // grantUse only grants Start/Stop/UpdateBrowserStream — the automation-stream
    // WebSocket needs ConnectBrowserAutomationStream, on both the browser ARN and
    // its session subresources.
    backOffice.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:GetBrowserSession'],
      resources: [browser.browserArn, `${browser.browserArn}/*`],
    }));
    props.openaiSecret.grantRead(backOffice.role);

    new cdk.CfnOutput(this, 'emailAgentRuntimeArn', { value: emailAgent.agentRuntimeArn });
    new cdk.CfnOutput(this, 'backOfficeRuntimeArn', { value: backOffice.agentRuntimeArn });
    new cdk.CfnOutput(this, 'browserId', { value: browser.browserId });
  }
}
