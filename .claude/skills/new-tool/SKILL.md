---
name: new-tool
description: Give an agent a new capability — a SaaS the assistant can use, a task-shaped function for automations, a new voice tool, or (trigger-gated) a platform tool for an open-ended model. Use when an agent needs to reach a new API (Salesforce, Slack, calendar) or a new internal capability.
---

# Add a capability

Pick the shape by WHO chooses the tool.

## An open-ended model needs a SaaS (My Assistant)

One rule: Composio's own tool, unless the tool must carry a rule the model cannot be trusted to keep. **Composio's own tool**: the tenant row lists the toolkit and the tool slugs under `assistant.composioTools`; the worker reads Composio's description and schema for each and shows them to the model as function tools, and each call the model makes runs as the `executeTool` activity, as the tenant, the newest release pinned, the result as Composio shaped it, bounded. No code; Composio maintains the definitions; every call is its own activity in the history, so a retried model call never repeats a write; the key never leaves the worker. **The catalog, only for a rule**: a slim tool of ours in `ASSISTANT_TOOLS` (`packages/worker/src/rules/assistant.ts`) plus its name in `ASSISTANT_TOOL_NAMES` (the contracts), with the Composio slug, `args` (the slug's arguments from the model's, with what we fill or forbid), `shape` (what the model reads back), and a pinned version; the tool's name on the row's `assistant.tools`. The catalog is for a rule: a ledger (the model drafts, a person's word acts), or an argument that must be forbidden (attendees on an invitation). Never for help or shaping: a phone format or a note's sign-off is a sentence in `TOOLKIT_HINTS` (`packages/worker/src/rules/assistant.ts`), data, and a result that is too big is Composio's to shape or a smaller tool's to fetch. Not MCP: OpenAI calling Composio itself would run a write inside the model call, which a retry could repeat, and needs the project key on every request.

1. Confirm Composio has the toolkit (`composio.dev/toolkits/<slug>`); list its tools and read their schemas from `GET /api/v3/tools?toolkit_slug=<slug>` with the platform key.
2. Owner consent: `npx tsx scripts/connect-composio.mts <tenantId> <toolkit>` (add the toolkit to `COMPOSIO_TOOLKITS` in `scripts/lib/composio.mts` if new). The daily canary expects every toolkit under `assistant.composioTools`, and the ones the row's flags imply (`expectedToolkits`).
3. Composio's tool: `"assistant": { "composioTools": { "<toolkit>": ["<TOOL_SLUG>", ...] } }` in the tenant file; re-seed. Nothing deploys. Catalog: the entry and the name, bump `BUILD_ID`, then the name in `assistant.tools`; re-seed.
4. If the model needs guidance the toolkit's schemas do not give (formats, ids), add one sentence to the channel line in `packages/worker/src/rules/assistant.ts` (`CHANNEL`, `systemPrompt`) — data, not code. The prompt already carries the time and the business's timezone.
5. Prove with `npx tsx scripts/test-assistant.mts "<a question that needs it>" <tenantId>`; the workflow history shows every call, with its arguments and result.

## The action reaches a customer irreversibly, or costs money (a post, an email, a refund)

Not a tool the model can run. The Actions ledger (`ActionSchema` in `@wnk/shared`, the Actions table) with `packages/worker/src/rules/facebook.ts` and `workflows/assistant/sms-turn.ts` as the worked example: the model gets a *draft* tool that writes a `pending` row; the workflow texts the draft word for word from the row; the person's exact approval word (`ACTION_APPROVAL_WORDS`, named after the action, never YES) is matched by the workflow before the model runs, on the revision they were shown; the workflow locks the row and executes, never retrying the irreversible call. `packages/worker/test/sms-turn.test.ts` holds this for Facebook (publishes once, only on the shown revision, never through the model); add the same checks for a new action type. Text-message approval is only as strong as the inbound webhook (a secret path today): for money, use a stronger approval than a texted word.

## A workflow needs a SaaS (CRM sync, lead email, caller recognition)

In a worker workflow, call the `executeTool(tenantId, slug, args, version)` activity (`packages/worker/src/activities/composio.ts`; `composioAccounts` and `composioProxy` for what no tool covers), the tenant id from the row the workflow resolved. In accept (`packages/receptionist/src/accept.ts`, a request handler), the same calls as budgeted fetches through Composio's proxy with an abort deadline each, so a slow lookup loses the race and never the call. Pin `version` for a new toolkit: the REST API runs a toolkit's OLDEST release when none is named, and Facebook's cannot post; list releases with `GET /api/v3/tools/<SLUG>` -> `available_versions`. Every call names the tenant. Spike the call with curl first to learn the response shape. A second CRM is another branch of activities selected by the row's `crm.type`; never a default.

## The voice receptionist needs a tool

In `packages/receptionist/src/agent.ts`: a zod args schema, a handler in `handlers` (one write or one publish — anything multi-step publishes an event and returns), a `tool({...})` entry in `TOOLS`; then list its name in the tenant's `tools`. Fields that differ between tenants belong on the tenant row, not in the schema.

## An open-ended model needs a PLATFORM tool (trigger-gated)

This is the trigger for AgentCore Gateway with a Lambda target and Cedar in front of that one capability. The last working shape — gateway stack, policy stack, interceptor, tools Lambda, per-tenant Cognito client — is at commit `832360b`. Recover only what that capability needs.
