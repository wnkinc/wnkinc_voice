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
  readonly voiceClient: cognito.UserPoolClient;
  readonly emailClient: cognito.UserPoolClient;
  readonly tokenUrl: string;
  /** Hosted-UI base URL for OAuth flows. */
  readonly authBaseUrl: string;

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

    // One app client per agent identity, so Policy can tell them apart by the
    // JWT's client_id: machine is the all-tools admin/test identity; voice and
    // email are least-privilege per-agent identities.
    const m2mClient = (id: string, name: string) =>
      this.userPool.addClient(id, {
        userPoolClientName: `${prefix}-${name}`,
        generateSecret: true,
        authFlows: {},
        oAuth: {
          flows: { clientCredentials: true },
          scopes: [cognito.OAuthScope.resourceServer(resourceServer, invokeScope)],
        },
      });
    this.machineClient = m2mClient('Machine', 'machine');
    this.voiceClient = m2mClient('VoiceAgent', 'voice-agent');
    this.emailClient = m2mClient('EmailAgent', 'email-agent');

    this.authBaseUrl = domain.baseUrl();
    this.tokenUrl = `${this.authBaseUrl}/oauth2/token`;
    new cdk.CfnOutput(this, 'userPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'machineClientId', { value: this.machineClient.userPoolClientId });
    new cdk.CfnOutput(this, 'voiceClientId', { value: this.voiceClient.userPoolClientId });
    new cdk.CfnOutput(this, 'emailClientId', { value: this.emailClient.userPoolClientId });
    new cdk.CfnOutput(this, 'tokenUrl', { value: this.tokenUrl });
  }
}
