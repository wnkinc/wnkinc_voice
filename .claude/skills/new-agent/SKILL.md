---
name: new-agent
description: Add a new agent (a new surface/system) — a harness on AgentCore Runtime, or a Lambda on an event, with its own packages/ folder, identity, and wiring. Use when adding an SMS responder, scheduler, dashboard API, or any new autonomous behavior.
---

# Add a new agent

**Harness first.** If the behavior is "a model with a prompt, tools, memory, and limits", it is an
AgentCore harness: a `CfnHarness` in `lib/runtime-stack.ts` (see the assistant), invoked from Step
Functions with the optimized `arn:aws:states:::bedrockagentcore:invokeHarness` state, reaching the
Gateway AS the tenant through the tenant's `gatewayOauthProviderArn` (tools override per
invocation). Zero agent code.

**Lambda second.** If the behavior is a fixed sequence (read the tenant, look something up, one
model call, one side effect) it is a Lambda on an EventBridge rule or a Step Functions task. The
email responder is the worked example: `packages/email-responder/src/responder.ts` + the rule,
function, DLQ, and alarms in `lib/runtime-stack.ts`.

**Runtime code agent last.** Only when neither fits: custom code between model and tools, a
non-loop pattern, bidirectional streaming, or a job longer than Lambda's 15 minutes. No helper
survives in the repo for this; the last one lived at commit `12a8245` (`bundleAgent` esbuild →
CJS `index.js` → NODE_22 code asset, and `runtimeServer` for the `/ping` + `/invocations`
contract). Recover those from history when the trigger fires, not before.

An agent = a `packages/<name>/` folder (behavior) + wiring in `packages/infrastructure/` (hosting, identity, grants).

## Steps

1. **Package**: create `packages/<name>/package.json` (`@wnk/<name>`, private, type module) and `src/<name>.ts` exporting `handler`. Keep behavior in a function that takes a channel-neutral payload so a test can drive it without the event envelope; channel-specific delivery stays in its own file.
2. **Shared code**: anything another deployable also needs goes in `packages/shared` (imported as `@wnk/shared`). Deployables never import each other.
3. **Hosting** in `lib/runtime-stack.ts`: a `NodejsFunction` (ESM, node22, ARM, X-Ray active, a dead-letter queue, `dlqAlarm` + `errorAlarm`) with env vars for everything the agent needs. If it imports `@wnk/shared/composio`, add the `createRequire` banner the email responder uses.
4. **Identity**: agents act AS the tenant — `tenantGatewayClient(gatewayConfigFromEnv(), tenant)` with a `GATEWAY_SCOPE` of its own (add the scope to the gateway stack's `allowedScopes`). Policy distinguishes agents by scope; no per-agent Cognito client.
5. **Grants**: the execution role gets exactly what the agent touches — tables, secrets, memory actions (`MEMORY_USE_ACTIONS` on the memory ARN + `/*`), `cognito-idp:DescribeUserPoolClient` on the pool. Expect to discover one missing action from an AccessDenied message; the error names the exact action + resource — encode it, don't wildcard the service.
6. **Trigger**: a bus event → `events.Rule` with the Lambda as target (`retryAttempts: 2`, the DLQ). A request/response surface → HTTP API route → Step Functions (`StepFunctions-StartExecution` integration, `Input: $request.body`), see the Telegram workflow. Prefer a state machine over a Lambda when the steps are all managed-service calls.
7. **Policy**: add a Cedar permit in `lib/policy-stack.ts` for the tools this agent may call (see the new-policy skill). Default deny means a new agent can call NOTHING until you do.
7b. **Tenant opt-in**: add a key under `products` in `TenantConfigSchema` (`packages/shared/src/types.ts`, default `enabled: false`) and pass `TENANTS_TABLE` + `grantReadData` in the runtime stack. The agent's first act is `requireTenant(store, payload.tenantId)` then its flag check — no `?? 'wnk'` defaults, ever. Tenants turn the service on in their row; no deploy per tenant.
8. **Prove it**: a `scripts/test-<name>.mts` that puts a real event on the bus (or invokes the function) and checks the side effect.
9. `npx tsc --noEmit && npm test`, `npx cdk deploy wnk-runtime-dev` (plus auth/policy stacks if touched), run the test script, commit.

## Logs

Lambda agents: `/aws/lambda/<function name>`. Harness: `/aws/bedrock-agentcore/runtimes/<name>-<id>-DEFAULT`.
