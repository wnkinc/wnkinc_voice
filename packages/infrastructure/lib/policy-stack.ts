import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export interface PolicyStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Cognito app client ids — the principals policies key on (JWT client_id tag). */
  readonly adminClientId: string;
  /** The gateway's id (from cdk.json context) — tool-specific policies must pin its ARN. */
  readonly gatewayId: string;
  readonly voiceClientId: string;
  readonly emailClientId: string;
}

/**
 * AgentCore Policy: the engine + Cedar rules the Gateway enforces on every
 * tool call. Attaching an engine flips the Gateway to DEFAULT DENY — anything
 * not explicitly permitted below is refused, which is the whole point: the
 * `tenant.tools` array asked the model to behave; this makes misbehavior
 * impossible.
 *
 * Tool-specific statements must pin the gateway ARN (service rule), which would
 * be a cross-stack cycle as a CFN reference — so the gateway id comes from
 * cdk.json context, like the gateway URL the voice stack uses.
 */
export class PolicyStack extends cdk.Stack {
  readonly engine: agentcore.CfnPolicyEngine;

  constructor(scope: Construct, id: string, props: PolicyStackProps) {
    super(scope, id, props);
    const { prefix, adminClientId, voiceClientId, emailClientId } = props;
    const gatewayArn = `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/${props.gatewayId}`;

    this.engine = new agentcore.CfnPolicyEngine(this, 'Engine', {
      name: `${prefix.replace(/-/g, '_')}_policy_engine`,
      description: 'Authorization rules for the WNK agent platform gateway',
    });

    const policy = (name: string, description: string, statement: string) =>
      new agentcore.CfnPolicy(this, name, {
        name: `${prefix.replace(/-/g, '_')}_${name}`,
        description,
        policyEngineId: this.engine.attrPolicyEngineId,
        definition: { cedar: { statement } },
      });

    // Admin/test identity: every tool. Scripts and debugging.
    policy('admin_all_tools', 'The machine (admin/test) client may call any tool', `
permit(
  principal is AgentCore::OAuthUser,
  action,
  resource is AgentCore::Gateway
)
when {
  principal.hasTag("client_id") &&
  principal.getTag("client_id") == "${adminClientId}"
};`);

    // Voice agent: exactly its two platform tools, and only for the provisioned
    // tenant. (When tenants multiply, the tenant guard becomes a claims-vs-input
    // match instead of a literal.)
    policy('voice_agent_tools', 'The voice agent may record leads and notify the owner for tenant wnk', `
permit(
  principal is AgentCore::OAuthUser,
  action in [AgentCore::Action::"voice___record_lead", AgentCore::Action::"voice___notify_owner"],
  resource == AgentCore::Gateway::"${gatewayArn}"
)
when {
  principal.hasTag("client_id") &&
  principal.getTag("client_id") == "${voiceClientId}" &&
  context.input.tenant_id == "wnk"
};`);

    // Email agent: read-only CRM context. No creates, no voice tools — default
    // deny covers the rest.
    policy('email_agent_tools', 'The email agent may read CRM context', `
permit(
  principal is AgentCore::OAuthUser,
  action in [AgentCore::Action::"hubspot___searchContacts", AgentCore::Action::"hubspot___getContact"],
  resource == AgentCore::Gateway::"${gatewayArn}"
)
when {
  principal.hasTag("client_id") &&
  principal.getTag("client_id") == "${emailClientId}"
};`);

    new cdk.CfnOutput(this, 'policyEngineArn', { value: this.engine.attrPolicyEngineArn });
  }
}
