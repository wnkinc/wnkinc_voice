# infrastructure

The platform as CDK stacks, bottom up; `bin/app.ts` is the wiring and the deploy order.
Names come from `names.ts`: one project, one stage (`wnk`, `dev`), so stacks are
`wnk-dev-<layer>` and physical names `wnk-dev-<resource>`. A second stage is a second value.

| Stack | Owns | Takes |
|---|---|---|
| `memory-stack.ts` | AgentCore Memory | nothing |
| `platform-stack.ts` | The tables, the bus, the HTTP API, the alarm topic, the OpenAI and Composio secrets, the activity log. Data and the bus, nothing that runs | nothing |
| `receptionist-stack.ts` | The call path: the verifier, accept and session Lambdas, the session queue, the webhook route | the platform's handles, memory |
| `worker-stack.ts` | The Temporal Worker, its invocation role and secret, the channel secrets, the three front doors, the platform's call-ended rule, the failure alarms, the Fargate fallback | the platform's handles, memory |
| `tenant-stack.ts` | One per tenant file with automations: rules filtered on its id, targeting the worker's starter | the bus, the starter |
| `telegram-mcp-stack.ts` | One per tenant file asking for it: the connector Lambda and its own secret | nothing |

## What the code is allowed to do

Declare. A stack names resources, grants exactly what each function touches, and wires
alarms; tenant configuration never appears in one (it is a row, a tenant-named secret, or
a tenant file). Every per-tenant resource carries the tenant id in its key. The stacks
import the contracts (`@wnk/shared/contracts`) and never a deployable's source.

## How to verify

```bash
npm test            # each stack's tenancy guarantees on its template: a tenant's rules name it alone, the worker's grants and the invocation role's trust, the receptionist's three Lambdas reach only their step, the platform runs nothing of ours
npm run diff        # what a deploy would change
```

Changes land through a pull request; the merge to main deploys every stack and releases
the worker. By hand, `npm run deploy -- <stack>` runs the tests first. When a stack stops
importing another's export, deploy the consumer alone first (`--exclusively`), then the
producer.
