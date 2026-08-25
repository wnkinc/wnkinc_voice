import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface IdentityStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Secrets Manager name of the per-tenant CRM secret holding HUBSPOT_TOKEN. */
  readonly hubspotSecretName: string;
  /** Secrets Manager name of the Google OAuth client (GOOGLE_OAUTH_CLIENT_ID/_SECRET). */
  readonly googleOauthSecretName: string;
}

/**
 * Outbound identity: AgentCore Identity credential providers (the token vault).
 * Agents never hold integration credentials — the Gateway pulls them from here
 * per call.
 *
 * Today: HubSpot via a private-app token (API key provider). Next: a Google
 * OAuth2 provider (3LO) once a Google Cloud OAuth client exists — that flow
 * lets each employee consent once and the vault manages their tokens.
 */
export class IdentityStack extends cdk.Stack {
  readonly hubspotProvider: agentcore.ApiKeyCredentialProvider;
  readonly googleProvider: agentcore.OAuth2CredentialProvider;
  readonly emailResponderIdentity: agentcore.WorkloadIdentity;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { prefix, hubspotSecretName, googleOauthSecretName } = props;

    this.hubspotProvider = new agentcore.ApiKeyCredentialProvider(this, 'Hubspot', {
      apiKeyCredentialProviderName: `${prefix.replace(/-/g, '_')}_hubspot`,
      apiKey: cdk.SecretValue.secretsManager(hubspotSecretName, { jsonField: 'HUBSPOT_TOKEN' }),
    });

    // Google 3LO: employees consent once ("Connect Gmail"); tokens live in the
    // vault. The provider's callbackUrl output must be added to the Google OAuth
    // client's Authorized redirect URIs (Google Cloud console) before consent works.
    this.googleProvider = agentcore.OAuth2CredentialProvider.usingGoogle(this, 'Google', {
      oAuth2CredentialProviderName: `${prefix.replace(/-/g, '_')}_google`,
      clientId: cdk.SecretValue.secretsManager(googleOauthSecretName, { jsonField: 'GOOGLE_OAUTH_CLIENT_ID' }).unsafeUnwrap(),
      clientSecret: cdk.SecretValue.secretsManager(googleOauthSecretName, { jsonField: 'GOOGLE_OAUTH_CLIENT_SECRET' }),
    });

    // 3LO session-binding callback: consent redirects land here and it calls
    // CompleteResourceTokenAuth so the vault can store the user's token.
    const oauthCallbackFn = new NodejsFunction(this, 'OauthCallback', {
      functionName: `${prefix}-oauth-callback`,
      description: 'AgentCore Identity 3LO return URL: binds consent sessions to users',
      entry: path.resolve(here, '../../onboarding/src/oauth-callback.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      bundling: { format: OutputFormat.ESM, target: 'node22' },
    });
    // CompleteResourceTokenAuth authorizes against the token-vault credential
    // provider resource (seen in the AccessDenied message), not the directory.
    oauthCallbackFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:CompleteResourceTokenAuth'],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/oauth2credentialprovider/*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
      ],
    }));
    // Completing auth makes the service read the provider's client secret from
    // the vault's service-managed Secrets Manager entries, as the caller.
    oauthCallbackFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!*`],
    }));
    const callbackUrl = oauthCallbackFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // The email responder's workload identity: the "who" that user tokens are
    // delegated to. The Runtime agent will assume this identity in phase 2.
    this.emailResponderIdentity = new agentcore.WorkloadIdentity(this, 'EmailResponder', {
      workloadIdentityName: `${prefix}-email-responder`,
      allowedResourceOauth2ReturnUrls: [callbackUrl.url],
    });

    new cdk.CfnOutput(this, 'oauthReturnUrl', { value: callbackUrl.url });

    new cdk.CfnOutput(this, 'emailResponderWorkloadName', { value: this.emailResponderIdentity.workloadIdentityName });
    new cdk.CfnOutput(this, 'hubspotProviderArn', { value: this.hubspotProvider.credentialProviderArn });
    new cdk.CfnOutput(this, 'googleProviderArn', { value: this.googleProvider.credentialProviderArn });
    new cdk.CfnOutput(this, 'googleCallbackUrl', { value: this.googleProvider.callbackUrl ?? '' });
  }
}
