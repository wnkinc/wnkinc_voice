import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

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

    new cdk.CfnOutput(this, 'hubspotProviderArn', { value: this.hubspotProvider.credentialProviderArn });
    new cdk.CfnOutput(this, 'googleProviderArn', { value: this.googleProvider.credentialProviderArn });
    new cdk.CfnOutput(this, 'googleCallbackUrl', { value: this.googleProvider.callbackUrl ?? '' });
  }
}
