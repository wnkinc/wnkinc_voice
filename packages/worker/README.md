# worker

The Temporal Worker: every workflow on the platform and the activities they call. It runs as
a container Lambda that Temporal Cloud invokes when the task queue has work (Serverless
Workers, public preview) and returns when the invocation deadline nears; idle costs nothing.
The same image is the three front doors (the SMS, Telegram and automation starters) and the
Fargate fallback at zero tasks.

## What it sits on

| Rented thing | What it does for us | Reference |
|---|---|---|
| Temporal Cloud, Serverless Workers | Durability, retries, timers, schedules, history; invokes the Lambda when there is work; routes each workflow to the build it started on | https://docs.temporal.io/production-deployment/worker-deployments/serverless-workers/aws-lambda |
| Temporal Worker Versioning | A build id per publish, pinned: nothing changes under a running workflow, rollback is one command | https://docs.temporal.io/worker-versioning |
| AgentCore Memory | The callers' and the people's memory across calls and chats | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html |
| Composio | The tenant's SaaS credentials (HubSpot, Gmail, Facebook) in a vault keyed by our tenant id; every call names the tenant | https://docs.composio.dev |
| OpenAI Responses API | The assistant's model, one call per round | https://platform.openai.com/docs/api-reference/responses |
| Twilio, Telegram Bot API | The SMS and Telegram channels: inbound posts on a secret path, replies as activities | |
| Browserbase | A tenant's saved browser, for the owner's `/login` | https://docs.browserbase.com |
| DynamoDB (platform stack) | Tenants, People, Calls (transcripts and once-markers), Actions (the approval ledger), Usage | |

## What the code is allowed to do, per folder

- `src/workflows/` — the bundle side: deterministic, replayed from history, only decides. No I/O, no clock beyond the workflow's own, no randomness; every side effect is an activity, imported as a type. `index.ts` is the one barrel Temporal registers. `assistant/` (the shared loop, the SMS and Telegram turns, browser login), `automations/` (one file per tenant automation; a tenant file lists them by name), `platform/` (call-ended and the two canaries: every tenant identically, by the worker stack's rule or a schedule). Every workflow carries the tenant it acts for as a search attribute (`src/search-attributes.ts`).
- `src/activities/` — the side effects: a table, a secret, a SaaS, the model, a channel. Each activity that acts for a tenant takes the tenant id as an argument and names it on every Composio call; none reads it from anywhere else. The clients are the shared ones (`@wnk/shared`: the store, Composio's HTTP API, the callers' memory, the secret reader), made once per container in `clients.ts`.
- `src/rules/` — pure functions both sides and the tests use: the assistant's tool catalog and prompts, the Facebook ledger rules, inbound SMS parsing, the automations' rules. No import but the contracts.
- `src/entry/` — the three processes on one image: `handler.ts` (the Lambda Temporal invokes), `starter.ts` (the front doors, each opening a workflow keyed by the request's own id so a redelivery starts nothing twice), `service.ts` (the fallback, long-running). The Temporal connection is read once from the stack's secret in `temporal.ts`.
- `src/version.ts` — the deployment name, the build id, the task queue. The names follow `packages/infrastructure/names.ts`; a test holds them in step.

Tenant id enters from an unforgeable input only: a rule's event (published by our own session Lambda), or the People row a channel identity resolves to. Neither the model nor a sender ever names a tenant.

## How to verify

```bash
npm test            # each workflow through a real Worker on Temporal's test server, time skipped, every activity a recorded fake (test/fakes.ts)
```

Against the deployed platform, per tenant:

- `npx tsx scripts/test-assistant.mts "who is Sarah?" <tenantId>` — a Telegram turn as the tenant's owner; the reply lands on their Telegram.
- `npx tsx scripts/test-crm-workflows.mts <tenantId> <phone>` and `npx tsx scripts/test-lead-email.mts <tenantId>` — the automations, from real events on the bus.
- `npm run temporal -- workflow list --query 'TenantId="<tenantId>"'` — every workflow of one tenant; `workflow show --workflow-id <id>` is the history, every activity with its input and result.

## Releasing

Every change that should reach the worker, code or configuration, is a new `BUILD_ID` in
`src/version.ts` (CI enforces it). The merge to main builds the image from the repo root
(`Dockerfile`; the root `.dockerignore` names what goes in), deploys, and runs
`npm run release`: an immutable Lambda version, a Worker Deployment Version registered against
it, the validation invocation confirmed to have bound the task queue, the version set current,
the schedules and the search attributes checked. Rollback:
`temporal worker deployment set-current-version --deployment-name wnk-dev-worker --build-id <previous>`.

## When it breaks

Two alarms from the SDK's own log lines in `/aws/lambda/wnk-dev-worker`: one failed workflow
pages; five failed activities in an hour page. Serverless Workers are a preview: the worker
stack's `fallbackService` output is the one command that runs the same image as a Fargate
service, and the queue drains with no release. Set it back to zero when the Lambda path is
healthy again.
