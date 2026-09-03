---
name: new-policy
description: Add or change Cedar authorization rules on the Gateway's policy engine — who may call which tools, with which arguments. Use for granting a new agent tools, restricting an existing one, or adding argument-level guards.
---

# Change Policy

Rules live in `lib/policy-stack.ts` as Cedar statements. The engine is attached to the gateway in ENFORCE mode → DEFAULT DENY: anything not explicitly permitted is refused, and a `forbid` beats any `permit`.

## Writing a statement

```cedar
permit(
  principal is AgentCore::OAuthUser,
  action in [AgentCore::Action::"<target>___<tool>", ...],
  resource == AgentCore::Gateway::"<gateway arn>"
)
when {
  principal.hasTag("client_id") &&
  principal.getTag("client_id") == "<cognito client id>" &&
  context.input.<arg> == "<value>"          // optional argument guard
};
```

Service rules learned the hard way:
- Tool-specific policies (constrained `action`) MUST pin the exact gateway ARN. It's built from `wnk:gatewayId` in `cdk.json` (context, not a stack reference — that would be a CFN cycle). Unconstrained-action policies may use `resource is AgentCore::Gateway`; bare `resource` is rejected.
- Principals are told apart by the JWT `client_id` tag — each agent has its own Cognito M2M client (`lib/cognito-stack.ts`). A new agent identity means a new client + a new permit.
- `context.input.*` is the tool-call arguments — argument-level guards (like the tenant check) only work because callers inject context args explicitly (see new-tool skill).

## Procedure

1. Add/edit the `policy(...)` call in `lib/policy-stack.ts`.
2. Extend the case matrix in `scripts/test-policy.mts` — every new permit gets an expect-ALLOW case AND at least one expect-DENY neighbor (wrong client, wrong tool, wrong argument).
3. `npx cdk deploy wnk-policy-dev` (gateway stack only if attach config changed).
4. `npx tsx scripts/test-policy.mts` — all rows must match their expectation. Denials read "Tool call not allowed due to policy enforcement".

## Notes

- Rolling out a risky change? The gateway attach supports `mode: 'LOG_ONLY'` (in `lib/gateway-stack.ts`) to trace decisions without enforcing.
- If the gateway stack fails deploying with policy-engine permission errors, the gateway role needs `bedrock-agentcore:GetPolicyEngine` + the `*Authorize*` action family, deployed BEFORE the gateway update (already handled via `policyDependable` ordering — keep it).

## Deploy order when a permit names NEW tools

Cedar statements are validated against the schema the Policy engine derives from the gateway's
current tools. A permit naming a tool whose target does not exist yet fails the policy deploy
("Failed to update policy definition"), and CDK orders `wnk-policy-dev` BEFORE `wnk-gateway-dev`
(the gateway consumes the engine ARN). So when a change adds a target AND permits for its tools:

```
npx cdk deploy wnk-voice-dev wnk-gateway-dev --exclusively --require-approval never
npx cdk deploy wnk-policy-dev --exclusively --require-approval never
```

Removing a target is the mirror image: drop its permits (deploy policy) before removing the target.
