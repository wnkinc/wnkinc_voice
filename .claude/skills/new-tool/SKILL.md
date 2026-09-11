---
name: new-tool
description: Give an agent a new capability — a SaaS the assistant can use, a task-shaped function for automations, a new voice tool, or (trigger-gated) a platform tool for an open-ended model. Use when an agent needs to reach a new API (Salesforce, Slack, calendar) or a new internal capability.
---

# Add a capability

Pick the shape by WHO chooses the tool.

## An open-ended model needs a SaaS (My Assistant)

Composio brokers it; the model gets Composio's meta tools over the tenant's session. No code.

1. Confirm Composio has the toolkit (`composio.dev/toolkits/<slug>`).
2. Owner consent: `npx tsx scripts/connect-composio.mts <tenantId> <toolkit>` (the adapter's `connectLink` creates a managed auth config on first use).
3. Re-mint the tenant's session so it includes the new toolkit: delete `composioMcpUrl` from `tenants/<id>.json`, then re-run the seed with `COMPOSIO_SECRET_ARN` set. Commit the new URL.
4. If the model needs guidance the toolkit's schemas do not give (formats, ids), add one sentence to the workflow prompt in `workflows/telegram.ts` — data, not code.
5. Prove with `npx tsx scripts/test-assistant.mts "<a question that needs it>"`.

## A workflow needs a SaaS (CRM sync, lead email, caller recognition)

Add an HTTP task state to the workflow file under `workflows/`: `httpTask(connectionArn, ...)` from `infra_utils/asl.ts` against Composio's v3.1 execute path, the tenant id as `user_id` in the body. Spike the call with curl first to learn the response shape (see the runtime stack's comments). A second CRM is another set of states selected by the row's `crm.type`; never a default.

## The voice receptionist needs a tool

In `packages/voice-session/src/agent.ts`: a zod args schema, a handler in `handlers` (one write or one publish — anything multi-step publishes an event and returns), a `tool({...})` entry in `TOOLS`; then list its name in the tenant's `tools`. Fields that differ between tenants belong on the tenant row, not in the schema.

## An open-ended model needs a PLATFORM tool (trigger-gated)

This is the trigger for AgentCore Gateway with a Lambda target and Cedar in front of that one capability. The last working shape — gateway stack, policy stack, interceptor, tools Lambda, per-tenant Cognito client — is at commit `832360b`. Recover only what that capability needs.
