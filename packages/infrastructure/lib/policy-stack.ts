import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export interface PolicyStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Cognito app client ids — the principals policies key on (JWT client_id tag). */
  readonly adminClientId: string;
  /** The gateway's id (from cdk.json context) — tool-specific policies must pin its ARN. */
  readonly gatewayId: string;

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
    const { prefix, adminClientId } = props;
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

    // ---- Agent permits by scope: the identity says which TENANT (client_id,
    // mapped by the Gateway interceptor, which runs before policy) and which
    // AGENT (scope, matched here). No client ids, no tenant ids in policy — a
    // new tenant never touches this stack. Every permit also requires the
    // tenant context the interceptor wrote, so a call it refused or skipped
    // cannot reach a tool.
    const tenantGuard = `context.input has tenant_id && context.input.tenant_id != ""`;
    policy('voice_scope_tools', 'A client acting as the voice agent may record leads and notify the owner', `
permit(
  principal is AgentCore::OAuthUser,
  action in [AgentCore::Action::"voice___record_lead", AgentCore::Action::"voice___notify_owner"],
  resource == AgentCore::Gateway::"${gatewayArn}"
)
when {
  principal.hasTag("scope") &&
  principal.getTag("scope") like "*gateway/voice*" &&
  ${tenantGuard}
};`);
    policy('email_scope_tools', 'A client acting as the email agent may read CRM context', `
permit(
  principal is AgentCore::OAuthUser,
  action in [AgentCore::Action::"crm___search_contacts", AgentCore::Action::"crm___get_contact"],
  resource == AgentCore::Gateway::"${gatewayArn}"
)
when {
  principal.hasTag("scope") &&
  principal.getTag("scope") like "*gateway/email*" &&
  ${tenantGuard}
};`);
    policy('assistant_scope_tools', "A client acting as the assistant may search, read, create CRM contacts and notes, and manage the owner's LinkedIn posts", `
permit(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"crm___search_contacts",
    AgentCore::Action::"crm___get_contact",
    AgentCore::Action::"crm___create_contact",
    AgentCore::Action::"crm___add_note",
    AgentCore::Action::"linkedin___get_profile",
    AgentCore::Action::"linkedin___create_post",
    AgentCore::Action::"linkedin___get_post",
    AgentCore::Action::"linkedin___delete_post"
  ],
  resource == AgentCore::Gateway::"${gatewayArn}"
)
when {
  principal.hasTag("scope") &&
  principal.getTag("scope") like "*gateway/assistant*" &&
  ${tenantGuard}
};`);

    new cdk.CfnOutput(this, 'policyEngineArn', { value: this.engine.attrPolicyEngineArn });
  }
}
