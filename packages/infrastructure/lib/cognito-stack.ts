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
  readonly assistantClient: cognito.UserPoolClient;
  /** The `gateway` resource server id; the seed script reads its scopes to mint tenant clients. */
  readonly resourceServerId: string;
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

    // Scopes name the AGENT; the app client names the TENANT. A tenant's own
    // client (created by the seed script, allowed every agent scope) requests
    // the scope of whichever agent is acting, so a JWT says both "for wnk"
    // (client_id, mapped by the Gateway interceptor) and "as the assistant"
    // (scope, matched by Policy). Nothing tenant-specific lives here.
    const mkScope = (name: string, description: string) => new cognito.ResourceServerScope({ scopeName: name, scopeDescription: description });
    const invokeScope = mkScope('invoke', 'Call tools through the AgentCore Gateway (admin/test)');
    const agentScopes = {
      voice: mkScope('voice', 'Acting as the voice receptionist'),
      email: mkScope('email', 'Acting as the email responder'),
      assistant: mkScope('assistant', 'Acting as My Assistant'),
    };
    const resourceServer = this.userPool.addResourceServer('Gateway', {
      identifier: 'gateway',
      scopes: [invokeScope, ...Object.values(agentScopes)],
    });

    // Platform clients: the admin/test identity, and the agents' own identities
    // during the cutover to per-tenant clients (they still inject tenant context
    // themselves; the interceptor lets them through by id).
    const m2mClient = (id: string, name: string, scopes: cognito.ResourceServerScope[]) =>
      this.userPool.addClient(id, {
        userPoolClientName: `${prefix}-${name}`,
        generateSecret: true,
        authFlows: {},
        oAuth: {
          flows: { clientCredentials: true },
          scopes: scopes.map((s) => cognito.OAuthScope.resourceServer(resourceServer, s)),
        },
      });
    this.machineClient = m2mClient('Machine', 'machine', [invokeScope, ...Object.values(agentScopes)]);
    this.voiceClient = m2mClient('VoiceAgent', 'voice-agent', [invokeScope, agentScopes.voice]);
    this.emailClient = m2mClient('EmailAgent', 'email-agent', [invokeScope, agentScopes.email]);
    this.assistantClient = m2mClient('AssistantAgent', 'assistant-agent', [invokeScope, agentScopes.assistant]);
    this.resourceServerId = resourceServer.userPoolResourceServerId;

    this.authBaseUrl = domain.baseUrl();
    this.tokenUrl = `${this.authBaseUrl}/oauth2/token`;
    new cdk.CfnOutput(this, 'userPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'machineClientId', { value: this.machineClient.userPoolClientId });
    new cdk.CfnOutput(this, 'voiceClientId', { value: this.voiceClient.userPoolClientId });
    new cdk.CfnOutput(this, 'emailClientId', { value: this.emailClient.userPoolClientId });
    new cdk.CfnOutput(this, 'assistantClientId', { value: this.assistantClient.userPoolClientId });
    new cdk.CfnOutput(this, 'resourceServerId', { value: this.resourceServerId });
    new cdk.CfnOutput(this, 'tokenUrl', { value: this.tokenUrl });
  }
}
