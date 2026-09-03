import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface IdentityStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** The platform OpenAI key ({"OPENAI_API_KEY": ...}); the assistant harness reads it from the vault. */
  readonly openaiSecret: secretsmanager.ISecret;
}

/**
 * Outbound identity: AgentCore Identity credential providers (the token vault).
 * Agents never hold integration credentials.
 *
 * Today: the OpenAI API key provider the assistant harness reads. Per-tenant
 * Gateway OAuth providers are minted by the seed script, not here. SaaS tools
 * (HubSpot, Gmail) are reached through Composio, whose vault holds the owner's
 * consent under the tenant id.
 */
export class IdentityStack extends cdk.Stack {
  /** API key provider holding the OpenAI key; harnesses reference it by ARN. */
  readonly openaiProvider: agentcore.ApiKeyCredentialProvider;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // Provider names appear in ARNs the harness validates with [a-zA-Z0-9-.]+ — no underscores.
    this.openaiProvider = new agentcore.ApiKeyCredentialProvider(this, 'OpenAi', {
      apiKeyCredentialProviderName: `${prefix}-openai`,
      apiKey: cdk.SecretValue.secretsManager(props.openaiSecret.secretArn, { jsonField: 'OPENAI_API_KEY' }),
    });

    new cdk.CfnOutput(this, 'openaiProviderArn', { value: this.openaiProvider.credentialProviderArn });
  }
}
