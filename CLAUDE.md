# wnkinc_voice — working agreements

Read the README for what the system is and how it runs. This file holds the goals
that decide *how* to change it.

## Two governing goals

1. **The smallest amount of custom code that offers multiple services safely
   across multiple tenants.**
2. **Thin product code on top of thick rented infrastructure.** Managed services
   (Temporal Cloud, AgentCore Memory, DynamoDB, EventBridge, Composio, OpenAI
   Realtime, Twilio) carry the enforcement: durability, retries, timers,
   schedules, credential vaults. Custom code only resolves tenant identity,
   threads it through, decides, and fails closed.

Why: this is a solo-built platform. Every line of custom code is maintenance and
a place tenancy can leak. Rented infra is where the isolation and auth guarantees
should live.

## Two execution styles, and which one a change gets

- **A workflow** (`packages/worker`): anything that is a sequence of steps over
  time, waits on a person or a timer, retries, or runs on a schedule. Workflow
  code is deterministic and only decides; every side effect is an activity.
  Temporal Cloud invokes the worker when there is work; idle costs nothing.
- **A request handler** (a plain Lambda): anything that must answer now, or must
  hold a live connection. The webhook verifier, accept (it answers while the
  caller hears ringing; a cold worker adds seconds there), the session Lambda
  holding the call, the starters that open workflows. Measured before chosen:
  the worker's cold pickup is about 2.7 s, the accept Lambda's about 0.5 s.

## How to apply

- Before proposing code, ask whether a managed service, a config row, or a CDK
  declaration can do it instead. Prefer data > declarative config > code.
- Tenant config and secrets (phone, persona, flags, people, tokens) belong in the
  tenant row, a tenant-named secret, or a vault keyed by tenant id. Never in CDK,
  env vars, or `?? 'wnk'` fallbacks.
- Tenant behavior (which automations a tenant runs, and in what shape) belongs in
  that tenant's file, `tenants/<id>.ts`: a list of workflows from the registry
  in the contracts (`packages/shared/src/contracts.ts`), each with that tenant's options, deployed as that tenant's own stack
  of rules filtered on its id. A variation for one tenant is an option the
  workflow reads with today's behavior as the default, or a workflow under its
  own name, in that order. Never a check of the tenant id inside a workflow
  another tenant runs on.
- Every change that should reach the worker, code or configuration, is a new
  `BUILD_ID` in `packages/worker/src/version.ts`: a published Lambda version is
  immutable, so nothing changes under a running workflow, and rollback is one
  Temporal command. CI enforces it (`scripts/check-build-id.mts`).
- Changes land through a pull request. CI runs the gate on the PR (typecheck,
  tests, the build-id guard) and, on the merge to main, deploys every stack and
  runs the worker release (`.github/workflows/ci.yml`). Deploying by hand is
  for a hotfix or a dev experiment: `npm run deploy -- <stack>` (it runs the
  tests first; a bare `cdk deploy` skips the gate), then `npm run release`.
  When a stack stops importing another's export, deploy the consumer alone
  first (`--exclusively`), then the producer; CI does this on every run.
- A workflow is tested through a real Worker on Temporal's test server with
  recorded fakes for its activities (`packages/worker/test/fakes.ts`), time
  skipped; a stack's tenancy guarantees are tests on its template. The tests
  are the gate; there are no snapshots to update.
- The coding agent runs as the `wnk-ops` operator profile: rows, secrets,
  workflows (start, read, signal), the release, logs, reads. It cannot deploy or
  change IAM, and it must not switch profiles to get around that. An
  AccessDenied names the action; the fix is a line in
  `ops/wnk-operate-policy.json`, committed with the reason and applied by a
  person (see `ops/README.md`).
- Build deferred items only when their trigger fires. The `new-tenant` skill keeps
  the trigger list. Don't pre-build membership models, per-tenant KMS keys, or
  config lineage. A task queue per tenant is deferred the same way: its trigger
  is a tenant that needs isolated capacity or a pinned build.
- A foundation move is worth making before its trigger when it shapes what every
  future addition imports or names: the contracts package, the stack layering,
  the names, a search attribute. Not when it multiplies operational surface with
  one instance today: a task queue, namespace, or key per tenant.
- Measure a proposal by lines of custom code added, not features shipped.
  Deleting a single-tenant default counts as progress.

## Safety invariants

- Tenant id comes only from unforgeable inputs: signed webhook called-number,
  verified JWT claim, events on our own bus, or a People-table row keyed by a
  channel identity the channel vouches for.
- The tenant is selected before any model runs, and that selection picks the
  credential: accept and the receptionist's tools carry the call's tenant, an
  automation takes it from the event, the assistant's loop from the People row,
  and every activity that acts for a tenant takes its id as an argument and
  names it on every Composio call. Neither the model nor a caller ever names a
  tenant. AgentCore Gateway with Cedar is a per-capability option for a model
  that needs platform tools, not a mandatory hop.
- Every per-tenant resource is addressed by tenant id in its key.
- A missing or unknown tenant fails closed.
- A service acts for a tenant only if that tenant's config enables it; a
  workflow checks the flag before its first side effect and returns `skipped`.
- Delivery is at-least-once everywhere. A workflow id built from domain identity
  (the lead, the call, the message) with reject-duplicate keeps a redelivered
  trigger from running twice; a once-marker after success (`readCall` /
  `markDone` in `packages/worker/src/activities/calls.ts`) narrows a duplicate
  side effect to a crash between the effect and the mark. Neither is
  exactly-once. Side effects that cost money or reach a customer irreversibly
  get a pending → completed ledger with reconciliation and a single-attempt
  activity (the Actions table; Facebook posts are the worked example), and that
  need is the trigger for building the ledger for a new action.

## Skills

`new-tenant`, `new-tool`, `new-agent` under `.claude/skills/` are
the procedures for the recurring changes. Use them before improvising.
