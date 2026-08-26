import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ConsoleStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly userPool: cognito.IUserPool;
  /** Cognito hosted-UI base URL (domain.baseUrl()). */
  readonly authBaseUrl: string;
  readonly callsTable: dynamodb.ITable;
  readonly leadsTable: dynamodb.ITable;
  readonly callerMemory: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * Read-only console (disposable v1): one Lambda Function URL serving the page
 * and a tenant-scoped read API. Tenancy comes from the ID token's
 * custom:businessId claim — the employees pool finally earns its keep.
 */
export class ConsoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsoleStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    const fn = new NodejsFunction(this, 'Api', {
      functionName: `${prefix}-console`,
      description: 'Read-only console: calls, leads, caller memory per tenant',
      entry: path.resolve(here, '../../console/src/api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(15),
      bundling: { format: OutputFormat.ESM, target: 'node22', banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      environment: {
        CALLS_TABLE: props.callsTable.tableName,
        LEADS_TABLE: props.leadsTable.tableName,
        MEMORY_ID: props.callerMemory.memoryId,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_DOMAIN: props.authBaseUrl,
      },
    });
    props.callsTable.grantReadData(fn);
    props.leadsTable.grantReadData(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: MEMORY_USE_ACTIONS,
      resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
    }));

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // The console's own app client: hosted-UI code+PKCE, redirecting back to the
    // function URL. adminUserPassword is enabled so a CLI smoke test can mint a
    // token without a browser (disposable-console convenience; drop for real).
    // Instantiated HERE (not pool.addClient) so the resource lives in this stack —
    // otherwise the auth stack would reference our URL and close a stack cycle.
    const client = new cognito.UserPoolClient(this, 'ConsoleClient', {
      userPool: props.userPool,
      userPoolClientName: `${prefix}-console`,
      generateSecret: false,
      authFlows: { adminUserPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [url.url],
      },
      preventUserExistenceErrors: true,
    });
    // Function env -> client id -> callback URL -> function would be a resource
    // cycle; the id travels via a fixed-name SSM parameter read at cold start.
    const clientIdParam = `/wnk/${prefix}/console-client-id`;
    new ssm.StringParameter(this, 'ClientIdParam', { parameterName: clientIdParam, stringValue: client.userPoolClientId });
    fn.addEnvironment('CONSOLE_CLIENT_PARAM', clientIdParam);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${clientIdParam}`],
    }));

    new cdk.CfnOutput(this, 'consoleUrl', { value: url.url });
    new cdk.CfnOutput(this, 'consoleClientId', { value: client.userPoolClientId });
  }
}
