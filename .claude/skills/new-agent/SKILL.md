---
name: new-agent
description: Add a new agent (a new surface/system) — a harness on AgentCore Runtime, or a Lambda on an event, with its own packages/ folder, identity, and wiring. Use when adding an SMS responder, scheduler, dashboard API, or any new autonomous behavior.
---

# Add a new agent

**The loop in a workflow first.** If the behavior is "a model with a prompt, tools, memory, and limits"
that a person drives by chatting, it is the assistant loop in `packages/worker/src/workflows/assistant/loop.ts`,
run by a channel's workflow on the worker: the model as an activity, each tool the model asks for gated
against the tenant row's `assistant.tools` and run through Composio naming the tenant, history and
recall from the platform Memory, rounds capped. A new channel is a workflow that resolves the person
and calls the loop (the SMS and Telegram turns are the two examples) plus a starter handler for its
front door. A new tool is a catalog entry in `packages/worker/src/rules/assistant.ts` (slim schema the
model sees, Composio slug and argument mapping that runs) plus its name in `ASSISTANT_TOOL_NAMES`. No
agent runtime. An AgentCore harness or Runtime is the option for a model that must write and run code
(a filesystem and a shell per session); this platform has none.

**Workflow second.** If the behavior is a fixed sequence of managed-service calls (read the
tenant, check a once-marker, fetch, format, send, write usage) it is a Temporal workflow in the
worker (`packages/worker/src/workflows/`) started by an EventBridge rule through the automation
starter, with no model. The lead email workflow (`workflows/automations/lead-email.ts`) is the
worked example: deterministic workflow code over activities (each taking the tenant id; Composio
named with the tenant as `user_id` on every call), the email formatted from the data already
fetched, the send one attempt, the once-marker after it, the WorkflowFailed alarm behind it.
Reach for the loop only when the step is open-ended (a person chatting); a fixed sequence
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
3. **Hosting**: a workflow needs none (it is in the worker's image; grant the worker what its activities touch in `stacks/worker-stack.ts` `grantWorker`). A Lambda goes in the stack of the system it serves (`voice-stack.ts` for the call path): a `NodejsFunction` (ESM, node22, ARM, X-Ray active, a dead-letter queue, `dlqAlarm` + `errorAlarm`) with env vars for everything it needs. If it imports `@wnk/shared/composio`, add the `createRequire` banner the voice-stack `fn` helper uses.
4. **Identity**: the agent acts for the tenant selected upstream — an automation takes `tenantId` from the event and passes it to every Composio adapter call; the assistant loop runs each tool through Composio naming the tenant from the row. No agent holds a credential or a Cognito identity.
5. **Grants**: the execution role gets exactly what the agent touches — tables, secrets, memory actions (`MEMORY_USE_ACTIONS` on the memory ARN + `/*`), `cognito-idp:DescribeUserPoolClient` on the pool. Expect to discover one missing action from an AccessDenied message; the error names the exact action + resource — encode it, don't wildcard the service.
6. **Trigger**: a bus event → `events.Rule` targeting the worker's automation starter with the workflow name (a tenant automation, below) or a Lambda (`retryAttempts: 2`, the DLQ). A request/response surface → HTTP API route → a starter handler in `packages/worker/src/entry/starter.ts` that opens a workflow keyed by the request's own id, see the Telegram front door. Prefer a workflow over a Lambda when the steps are all managed-service calls.
7. **Allow-list**: for the assistant, the catalog in `packages/worker/src/rules/assistant.ts` and the row's `assistant.tools`; for a Lambda, the code is the policy. A platform tool for an open-ended model is the trigger for a Gateway + Cedar (new-tool skill).
7b. **Tenant opt-in**: a bus-driven automation that tenants may run differently is a tenant automation: a workflow in `packages/worker/src/workflows/automations/`, an entry in `AUTOMATIONS` in `packages/shared/src/contracts.ts` (the event that starts it), and a line in `tenants/<id>.ts` for each tenant that gets it (with options, if that tenant runs it differently); the tenant stack deploys a rule matching only that tenant's events. No row flag needed for that. A platform workflow every tenant gets identically (like callEnded) is a rule in the worker stack with the same starter; if it acts per tenant, its first steps are the tenant lookup by the event's `tenantPhoneNumber` and a check of its service block's `enabled` (a new block in `TenantConfigSchema`, default `false`); a missing row or a false flag returns `skipped` without acting — no `?? 'wnk'` defaults, ever.
8. **Prove it**: a `scripts/test-<name>.mts` that puts a real event on the bus (or invokes the function) and checks the side effect.
9. `npx tsc --noEmit && npm test`, bump `BUILD_ID` in `packages/worker/src/version.ts`, commit on a branch, open the PR; the merge to main deploys and releases (CI). Then run the test script against what deployed.

## Logs

Lambdas: `/aws/lambda/<function name>`. Workflows: the history (`npm run temporal -- workflow show --workflow-id <id>`: every activity with its input and result) and the worker's log group, `/aws/lambda/wnkinc-voice-dev-worker`, where the failure alarms read from.
