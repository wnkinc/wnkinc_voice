---
name: new-agent
description: Scaffold a new agent (a new surface/system) on AgentCore Runtime — its own packages/ folder, Runtime hosting, identity, and wiring. Use when adding an SMS responder, scheduler, dashboard API, or any new autonomous behavior.
---

# Add a new agent

An agent = a `packages/<name>/` folder (behavior) + wiring in `packages/infrastructure/` (hosting, identity, grants). Follow the email-responder as the worked example; back-office shows the Browser variant.

## Steps

1. **Package**: create `packages/<name>/package.json` (`@wnk/<name>`, private, type module) and `src/agent.ts`. Implement the Runtime HTTP contract by hand (~40 lines — copy it from `packages/email-responder/src/agent.ts`): `GET /ping` → `{"status":"Healthy"}`, `POST /invocations` → JSON in, JSON out, listen on `0.0.0.0:8080`. Do NOT use the `bedrock-agentcore` npm SDK — it createRequire()s optional fastify plugins that a single-file bundle can't satisfy.
2. **Shared code**: anything another deployable also needs goes in `packages/shared` (imported as `@wnk/shared`). Deployables never import each other.
3. **Hosting** in `lib/runtime-stack.ts`: `bundleAgent('<name>')` (already generalizes the esbuild → CJS `index.js` → NODE_22 code-asset pattern; entrypoint must be the bare `.js` filename), then a `new agentcore.Runtime(...)` with env vars for everything the agent needs. No Docker.
4. **Identity**: give the agent its own Cognito M2M client in `lib/cognito-stack.ts` (copy the `m2mClient(...)` line) if it will call Gateway tools — Policy distinguishes agents by JWT `client_id`. Pass the client id via env.
5. **Grants**: the execution role gets exactly what the agent touches — `openaiSecret.grantRead`, memory actions (`MEMORY_USE_ACTIONS` on the memory ARN + `/*`), vault/token actions, `cognito-idp:DescribeUserPoolClient` on the pool. Expect to discover one missing action from an AccessDenied message; the error names the exact action + resource — encode it, don't wildcard the service.
6. **Trigger**: EventBridge rule + small trigger Lambda calling `InvokeAgentRuntime` (session ids must be ≥33 chars) for event-driven agents; direct `InvokeAgentRuntime` from a script for task-driven ones.
7. **Policy**: add a Cedar permit in `lib/policy-stack.ts` for the tools this agent may call (see the new-policy skill). Default deny means a new agent can call NOTHING until you do.
8. **Prove it**: a `scripts/test-<name>.mts` that invokes the agent end to end, plus a smoke test of the bundle locally: `node packages/infrastructure/.build/<name>/index.js` then `curl localhost:8080/ping`.
9. `npx tsc --noEmit && npm test`, `npx cdk deploy wnk-runtime-dev` (plus auth/policy stacks if touched), run the test script, commit.

## Runtime logs

`/aws/bedrock-agentcore/runtimes/<runtime_name>-<id>-DEFAULT`. A 424 from InvokeAgentRuntime means the container crashed or missed the 30s init deadline — the log group has the real error.
