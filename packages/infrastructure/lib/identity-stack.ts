import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export interface IdentityStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Secrets Manager name of the per-tenant CRM secret holding HUBSPOT_TOKEN. */
  readonly hubspotSecretName: string;
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

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { prefix, hubspotSecretName } = props;

    this.hubspotProvider = new agentcore.ApiKeyCredentialProvider(this, 'Hubspot', {
      apiKeyCredentialProviderName: `${prefix.replace(/-/g, '_')}_hubspot`,
      apiKey: cdk.SecretValue.secretsManager(hubspotSecretName, { jsonField: 'HUBSPOT_TOKEN' }),
    });

    new cdk.CfnOutput(this, 'hubspotProviderArn', { value: this.hubspotProvider.credentialProviderArn });
  }
}
