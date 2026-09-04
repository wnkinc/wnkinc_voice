# shared

The code every Lambda imports: types, persistence, events, config, and the adapters to the
rented services. Nothing here runs on its own.

## What lives here

| File | What | Rule it enforces |
|---|---|---|
| `types.ts` | `TenantConfigSchema` (zod), call and person records, `Lead`, the `VoiceEvent` union | Tenant data lives in the row, validated on write. |
| `store.ts` | `Store` interface over DynamoDB (Tenants, Calls, People) plus an in-memory version for tests | `isDone` / `markDone` once-markers on the call row; `claimCall` conditional put. No leads table: the CRM holds the lead, the call row is the audit. |
| `tenant.ts` | `requireTenant` | The one way an event's tenant id becomes a tenant. Missing or unknown throws. No fallback business. |
| `events.ts` | EventBridge publisher | Carries the X-Ray trace header so consumers join the call's trace. |
| `config.ts` | Env vars, Secrets Manager, OpenAI client, JSON logger | |
| `prompt.ts` | Tenant row → receptionist system prompt | Lives here so the console can render the same prompt. |
| `composio.ts` | Composio SDK for the scripts: consent links, the owner's Gmail address, the harness's meta-tools session | The only file that may import `@composio/core`. Nothing at runtime imports it; the workflows call Composio's HTTP API with the tenant id as `user_id`. |
| `memory.ts` | AgentCore Memory: write transcripts, recall facts | Actor id is `<tenantId>_<phone>`, so isolation is structural. |
| `usage.ts`, `rates.ts` | Metering records and the rate card | Never throws; a metering failure must not hurt the work. |
| `phone.ts`, `trace.ts` | E.164 normalizing; X-Ray header helpers | |

## References

- Composio SDK and tool slugs: https://docs.composio.dev
- AgentCore Memory: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html
- DynamoDB condition expressions (behind `claimCall` and `markDone`): https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html

## How to verify

```bash
npm test            # trace, types, usage suites
```

Against real services, per tenant:

- `npx tsx scripts/test-crm-workflows.mts <tenantId> <phone>` — HubSpot through the CRM workflows.
- `npx tsx scripts/test-memory.mts` — write a transcript, poll until extraction yields records.
- `npx tsx scripts/test-composio.mts` — Gmail send through Composio.
