---
name: new-agent
description: Scaffold a new agent (a new surface/system) on AgentCore Runtime — its own packages/ folder, Runtime hosting, identity, and wiring. Use when adding an SMS responder, scheduler, dashboard API, or any new autonomous behavior.
---

# Add a new agent

**Harness first.** If the behavior is "a model with a prompt, tools, memory, and limits", it is an
AgentCore harness: a `CfnHarness` in `lib/runtime-stack.ts` (see the assistant), invoked from Step
Functions with the optimized `arn:aws:states:::bedrockagentcore:invokeHarness` state, reaching the
Gateway AS the tenant through the tenant's `gatewayOauthProviderArn` (tools override per
invocation). Zero agent code. Reach for a Runtime agent (below) only when configuration isn't
enough: custom code between model and tools, a non-loop pattern, bidirectional streaming.

An agent = a `packages/<name>/` folder (behavior) + wiring in `packages/infrastructure/` (hosting, identity, grants). Follow the email-responder as the worked example; back-office shows the Browser variant.

## Steps

1. **Package**: create `packages/<name>/package.json` (`@wnk/<name>`, private, type module) and `src/agent.ts`. The Runtime HTTP contract is one call: `runtimeServer('<name>', async (payload, trace) => result)` from `@wnk/shared` (`GET /ping`, `POST /invocations`, 8080, 500 on throw). Do NOT use the `bedrock-agentcore` npm SDK — it createRequire()s optional fastify plugins that a single-file bundle can't satisfy. Keep behavior in a `core.ts` that takes a channel-neutral payload and injectable deps (store, gateway, memory) so it is unit-testable and any channel can drive it; channel-specific delivery (e.g. `telegram.ts`) stays in its own file.
2. **Shared code**: anything another deployable also needs goes in `packages/shared` (imported as `@wnk/shared`). Deployables never import each other.
3. **Hosting** in `lib/runtime-stack.ts`: `bundleAgent('<name>')` (already generalizes the esbuild → CJS `index.js` → NODE_22 code-asset pattern; entrypoint must be the bare `.js` filename), then a `new agentcore.Runtime(...)` with env vars for everything the agent needs. No Docker.
4. **Identity**: give the agent its own Cognito M2M client in `lib/cognito-stack.ts` (copy the `m2mClient(...)` line) if it will call Gateway tools — Policy distinguishes agents by JWT `client_id`. Pass the client id via env.
5. **Grants**: the execution role gets exactly what the agent touches — `openaiSecret.grantRead`, memory actions (`MEMORY_USE_ACTIONS` on the memory ARN + `/*`), vault/token actions, `cognito-idp:DescribeUserPoolClient` on the pool. Expect to discover one missing action from an AccessDenied message; the error names the exact action + resource — encode it, don't wildcard the service.
6. **Trigger**: prefer no Lambda. Step Functions calls `InvokeAgentRuntime` directly (`tasks.CallAwsService` with `service: 'bedrockagentcore'`, `iamAction: 'bedrock-agentcore:InvokeAgentRuntime'`; the streaming body arrives as a JSON string in `Response`) — verified 2026-09-02; HTTP API routes can start the workflow with the `StepFunctions-StartExecution` integration and `Input: $request.body`. See the Telegram workflow in `lib/runtime-stack.ts`. EventBridge rule + trigger Lambda remains for bus events (email responder). Session ids must be ≥33 chars.
7. **Policy**: add a Cedar permit in `lib/policy-stack.ts` for the tools this agent may call (see the new-policy skill). Default deny means a new agent can call NOTHING until you do.
7b. **Tenant opt-in**: add a key under `products` in `TenantConfigSchema` (`packages/shared/src/types.ts`, default `enabled: false`) and pass `TENANTS_TABLE` + `grantReadData` in the runtime stack. The agent's first act is `requireTenant(store, payload.tenantId)` then its flag check — no `?? 'wnk'` defaults, ever. Tenants turn the service on in their row; no deploy per tenant.
8. **Prove it**: a `scripts/test-<name>.mts` that invokes the agent end to end, plus a smoke test of the bundle locally: `node packages/infrastructure/.build/<name>/index.js` then `curl localhost:8080/ping`.
9. `npx tsc --noEmit && npm test`, `npx cdk deploy wnk-runtime-dev` (plus auth/policy stacks if touched), run the test script, commit.

## Runtime logs

`/aws/bedrock-agentcore/runtimes/<runtime_name>-<id>-DEFAULT`. A 424 from InvokeAgentRuntime means the container crashed or missed the 30s init deadline — the log group has the real error.
