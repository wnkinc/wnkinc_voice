import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface CognitoStackProps extends cdk.StackProps {
  readonly prefix: string;
}

/**
 * Inbound identity for the platform: who may talk to the Gateway (and later,
 * the Runtime agents). Employees get user accounts with a `businessId` custom
 * attribute; machine clients (agents, test scripts) use the client-credentials
 * flow against the `gateway/invoke` scope.
 */
export class CognitoStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly machineClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    this.userPool = new cognito.UserPool(this, 'Employees', {
      userPoolName: `${prefix}-employees`,
      selfSignUpEnabled: false, // only admins create users
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        // Rides into JWTs as custom:businessId; every downstream layer keys on it.
        businessId: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: false }),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // learning stack
    });

    // Hosted domain: the OAuth token endpoint for the client-credentials flow.
    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `${prefix}-${this.account}` },
    });

    const invokeScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'Call tools through the AgentCore Gateway',
    });
    const resourceServer = this.userPool.addResourceServer('Gateway', {
      identifier: 'gateway',
      scopes: [invokeScope],
    });

    // Machine-to-machine client: agents and test scripts exchange this client's
    // credentials for a JWT the Gateway's authorizer accepts.
    this.machineClient = this.userPool.addClient('Machine', {
      userPoolClientName: `${prefix}-machine`,
      generateSecret: true,
      authFlows: {},
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [cognito.OAuthScope.resourceServer(resourceServer, invokeScope)],
      },
    });

    new cdk.CfnOutput(this, 'userPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'machineClientId', { value: this.machineClient.userPoolClientId });
    new cdk.CfnOutput(this, 'tokenUrl', { value: `${domain.baseUrl()}/oauth2/token` });
  }
}
