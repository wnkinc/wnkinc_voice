# shared

What more than one deployable shares: the contracts, the rows, one client each to the rented
services, the config. Nothing here runs on its own. The worker's image installs this package
and its dependencies, so nothing heavy belongs here.

## What lives here

| File | What | Rule it enforces |
|---|---|---|
| `contracts.ts` | What more than one deployable must agree on: the tool and approval names, the rows as read back (`TenantRow`, `PersonRecord`, `DraftRow`), `Lead` and the `VoiceEvent` union, the automation registries, the tenant file's type. No runtime import: the workflow bundle and the CDK stacks take it with nothing behind it (`test/contracts.test.ts` holds that). Exported as `@wnk/shared/contracts`. | One spelling of every shared name; the worker and the stacks import it, never each other. |
| `types.ts` | `TenantConfigSchema` (zod) and the call record | Tenant data lives in the row, validated on write. |
| `store.ts` | `Store` over DynamoDB (Tenants, Calls, People) plus an in-memory version for tests: the tenant and people reads every side makes (the receptionist, the worker's identity activities, the scripts), the seed's writes, the session's call row. What one side alone writes (once-markers, the ledger, the browser window) stays in that side's activities. | One read of a row, validated: a row that no longer parses fails closed. No leads table: the CRM holds the lead, the call row is the audit. |
| `composio-api.ts` | Composio's HTTP API, the one client: run a tool, list a tenant's accounts, the proxy; every call names the tenant, and takes a deadline. The worker's activities and accept use it. | The tenant is an argument from the resolved row, never a model's or a caller's word. |
| `memory.ts` | The callers' memory (AgentCore Memory), the one client: retrieve by relevance, a session's history, write an event. | Actor ids start with the tenant id: isolation is structural. |
| `secrets.ts` | A JSON secret by ARN, read once per process | Missing config fails closed at the caller. |
| `events.ts` | EventBridge publisher | Carries the X-Ray trace header so consumers join the call's trace. |
| `config.ts` | Env vars, the OpenAI secret, JSON logger | |
| `phone.ts`, `trace.ts` | E.164 normalizing; X-Ray header helpers | |

## References

- Composio SDK and tool slugs: https://docs.composio.dev
- AgentCore Memory: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
- DynamoDB condition expressions (behind the claim, the once-markers, the ledger's locks): https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html

## How to verify

```bash
npm test            # trace, types suites
```

Against real services, per tenant:

- `npx tsx scripts/test-crm-workflows.mts <tenantId> <phone>` — HubSpot through the CRM workflows.
- `npx tsx scripts/test-lead-email.mts <tenantId>` — Gmail send through the lead email workflow.
