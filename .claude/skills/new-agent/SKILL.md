---
name: new-agent
description: Add a new agent (a new surface/system) — a harness on AgentCore Runtime, or a Lambda on an event, with its own packages/ folder, identity, and wiring. Use when adding an SMS responder, scheduler, dashboard API, or any new autonomous behavior.
---

# Add a new agent

**Harness first.** If the behavior is "a model with a prompt, tools, memory, and limits", it is an
AgentCore harness: a `CfnHarness` in `stacks/runtime-stack.ts` (see the assistant), invoked from Step
Functions with the optimized `arn:aws:states:::bedrockagentcore:invokeHarness` state, reaching the
the tenant's Composio MCP session through its `composioMcpUrl` (tools override per invocation).
Zero agent code.

**Workflow second.** If the behavior is a fixed sequence of managed-service calls (read the
tenant, check a once-marker, fetch, format, send, write usage) it is a Step Functions state
machine on an EventBridge rule, with no package and no model. The lead email workflow in
`workflows/lead-email.ts` is the worked example (one definition per file under `workflows/`, wrapped in a state machine in `stacks/runtime-stack.ts`): JSONata states, Composio reached with HTTP tasks
through an EventBridge Connection (the tenant id as `user_id` on every call), the email formatted
in JSONata from the data already fetched, `failedExecutionsAlarm` + a DLQ on the rule target.
Reach for the harness only when the step is open-ended (a person chatting); a fixed sequence
never needs a model, and a model in the loop costs ~90k tokens per run.

**Lambda third.** Only when a step needs code (an HMAC check, deterministic writes with fixed
fields such as the CRM sync) is it a Lambda on an EventBridge rule: `packages/<name>/` +
`NodejsFunction` with a DLQ and alarms.

**Runtime code agent last.** Only when neither fits: custom code between model and tools, a
non-loop pattern, bidirectional streaming, or a job longer than Lambda's 15 minutes. No helper
survives in the repo for this; the last one lived at commit `12a8245` (`bundleAgent` esbuild →
CJS `index.js` → NODE_22 code asset, and `runtimeServer` for the `/ping` + `/invocations`
contract). Recover those from history when the trigger fires, not before.

An agent = a `packages/<name>/` folder (behavior) + wiring in `packages/infrastructure/` (hosting, identity, grants).

## Steps

1. **Package**: create `packages/<name>/package.json` (`@wnk/<name>`, private, type module) and `src/<name>.ts` exporting `handler`. Keep behavior in a function that takes a channel-neutral payload so a test can drive it without the event envelope; channel-specific delivery stays in its own file.
2. **Shared code**: anything another deployable also needs goes in `packages/shared` (imported as `@wnk/shared`). Deployables never import each other.
3. **Hosting** in `stacks/runtime-stack.ts`: a `NodejsFunction` (ESM, node22, ARM, X-Ray active, a dead-letter queue, `dlqAlarm` + `errorAlarm`) with env vars for everything the agent needs. If it imports `@wnk/shared/composio`, add the `createRequire` banner the voice-stack `fn` helper uses.
4. **Identity**: the agent acts for the tenant selected upstream — an automation takes `tenantId` from the event and passes it to every Composio adapter call; a harness is handed the tenant's `composioMcpUrl` per invocation. No agent holds a credential or a Cognito identity.
5. **Grants**: the execution role gets exactly what the agent touches — tables, secrets, memory actions (`MEMORY_USE_ACTIONS` on the memory ARN + `/*`), `cognito-idp:DescribeUserPoolClient` on the pool. Expect to discover one missing action from an AccessDenied message; the error names the exact action + resource — encode it, don't wildcard the service.
6. **Trigger**: a bus event → `events.Rule` with the Lambda as target (`retryAttempts: 2`, the DLQ). A request/response surface → HTTP API route → Step Functions (`StepFunctions-StartExecution` integration, `Input: $request.body`), see the Telegram workflow. Prefer a state machine over a Lambda when the steps are all managed-service calls.
7. **Allow-list**: for a harness, the Composio session's toolkits (minted by the seed) and the harness `allowedTools`; for a Lambda, the code is the policy. A platform tool for an open-ended model is the trigger for a Gateway + Cedar (new-tool skill).
7b. **Tenant opt-in**: add a key under `products` in `TenantConfigSchema` (`packages/shared/src/types.ts`, default `enabled: false`) and pass `TENANTS_TABLE` + `grantReadData` in the runtime stack. The agent's first states are the tenant lookup by the event's `tenantPhoneNumber` and a Choice on its flag (see `workflows/lead-email.ts` LookupTenant → ResponderEnabled); a missing row or a false flag ends in Succeed without acting — no `?? 'wnk'` defaults, ever. Tenants turn the service on in their row; no deploy per tenant.
8. **Prove it**: a `scripts/test-<name>.mts` that puts a real event on the bus (or invokes the function) and checks the side effect.
9. **Describe it**: export `outcomes: UnitOutcomes` from the definition or handler file — the four answers (what comes in, what goes out when it works, what else it leaves behind, how it ends badly and who hears). The doc comment at the top is the how. `npm run synth && npx tsx scripts/catalog.ts` regenerates `tenant-profiles/catalog.md` from cdk.out plus those; a unit without outcomes shows as UNDESCRIBED.
10. `npx tsc --noEmit && npm test`, `npx cdk deploy wnk-runtime-dev` (plus auth/policy stacks if touched), run the test script, commit.

## Logs

Lambda agents: `/aws/lambda/<function name>`. Harness: `/aws/bedrock-agentcore/runtimes/<name>-<id>-DEFAULT`.
