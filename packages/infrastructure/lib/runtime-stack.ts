import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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

    // Bundle the agent at synth time, same pattern NodejsFunction uses for Lambdas.
    const dist = path.resolve(here, '../.build/email-responder');
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    // Pin CJS interpretation of index.js regardless of any parent package.json.
    writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    // CJS + .js: the managed NODE_22 runtime requires a .js entrypoint, and CJS
    // sidesteps any type:module ambiguity in how it launches the file.
    buildSync({
      entryPoints: [path.resolve(here, '../../email-responder/src/agent.ts')],
      outfile: path.join(dist, 'index.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      sourcemap: false,
      logLevel: 'warning',
      // Deps use import.meta.url (undefined under CJS); shim it to this file's URL.
      define: { 'import.meta.url': '__importMetaUrl' },
      banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
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
        OWNER_USER_ID: 'wesley',
        GOOGLE_PROVIDER_NAME: props.googleProviderName,
        OPENAI_SECRET_ARN: props.openaiSecret.secretArn,
      },
    });

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
    emailAgent.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:DescribeUserPoolClient'],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`],
    }));

    // lead.recorded -> trigger Lambda -> InvokeAgentRuntime
    const triggerFn = new NodejsFunction(this, 'EmailTrigger', {
      functionName: `${prefix}-email-trigger`,
      description: 'Invokes the email responder runtime for each lead.recorded event',
      entry: path.resolve(here, '../../email-responder/src/trigger.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      environment: { EMAIL_AGENT_RUNTIME_ARN: emailAgent.agentRuntimeArn },
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
      targets: [new targets.LambdaFunction(triggerFn, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1) })],
    });

    new cdk.CfnOutput(this, 'emailAgentRuntimeArn', { value: emailAgent.agentRuntimeArn });
  }
}
