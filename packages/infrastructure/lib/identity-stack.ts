import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface IdentityStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** The platform OpenAI key ({"OPENAI_API_KEY": ...}); the assistant harness reads it from the vault. */
  readonly openaiSecret: secretsmanager.ISecret;
  /** The platform Composio key ({"COMPOSIO_API_KEY": ...}); the harness sends it to the tenant's Composio MCP session. */
  readonly composioSecret: secretsmanager.ISecret;
}

/**
 * Outbound identity: AgentCore Identity credential providers (the token vault).
 * Agents never hold integration credentials.
 *
 * Today: the OpenAI and Composio API key providers the assistant harness
 * reads (the Composio key rides as a header to the tenant's MCP session, by
 * ARN, never in a template). Per-tenant Gateway OAuth providers are minted by
 * the seed script, not here. SaaS credentials live in Composio's vault under
 * the tenant id.
 */
export class IdentityStack extends cdk.Stack {
  /** API key provider holding the OpenAI key; harnesses reference it by ARN. */
  readonly openaiProvider: agentcore.ApiKeyCredentialProvider;
  /** API key provider holding the Composio key, for the harness's remote MCP header. */
  readonly composioProvider: agentcore.ApiKeyCredentialProvider;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // Provider names appear in ARNs the harness validates with [a-zA-Z0-9-.]+ — no underscores.
    this.openaiProvider = new agentcore.ApiKeyCredentialProvider(this, 'OpenAi', {
      apiKeyCredentialProviderName: `${prefix}-openai`,
      apiKey: cdk.SecretValue.secretsManager(props.openaiSecret.secretArn, { jsonField: 'OPENAI_API_KEY' }),
    });

    this.composioProvider = new agentcore.ApiKeyCredentialProvider(this, 'Composio', {
      apiKeyCredentialProviderName: `${prefix}-composio`,
      apiKey: cdk.SecretValue.secretsManager(props.composioSecret.secretArn, { jsonField: 'COMPOSIO_API_KEY' }),
    });

    new cdk.CfnOutput(this, 'openaiProviderArn', { value: this.openaiProvider.credentialProviderArn });
    new cdk.CfnOutput(this, 'composioProviderArn', { value: this.composioProvider.credentialProviderArn });
  }
}
