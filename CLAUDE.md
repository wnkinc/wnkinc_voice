# wnkinc_voice — working agreements

Read the README for what the system is and how it runs. This file holds the goals
that decide *how* to change it.

## Two governing goals

1. **The smallest amount of custom code that offers multiple services safely
   across multiple tenants.**
2. **Thin product code on top of thick rented infrastructure.** Managed services
   (AgentCore Identity/Memory/Runtime, DynamoDB, EventBridge, Step
   Functions, Composio, OpenAI Realtime, Twilio) carry the enforcement. Custom
   code only resolves tenant identity, threads it through, and fails closed.

Why: this is a solo-built platform. Every line of custom code is maintenance and
a place tenancy can leak. Rented infra is where the isolation and auth guarantees
should live.

## How to apply

- Before proposing code, ask whether a managed service, a config row, or a CDK
  declaration can do it instead. Prefer data > declarative config > code.
- Tenant config and secrets (phone, persona, flags, people, tokens) belong in the
  tenant row, a tenant-named secret, or a vault keyed by tenant id. Never in CDK,
  env vars, Cedar literals, or `?? 'wnk'` fallbacks.
- Tenant behavior (which automations a tenant runs, and in what shape) belongs in
  that tenant's file, `tenants/<id>.ts`, deployed as that tenant's own stack with
  rules filtered on its id. A variation for one tenant is a parameter on the
  definition, a recomposition, or a copied definition in that file, in that order
  of preference. Never a Choice state inside a definition another tenant runs on.
- Build deferred items only when their trigger fires. The `new-tenant` skill keeps
  the trigger list. Don't pre-build membership models, per-tenant KMS keys, or
  config lineage.
- Measure a proposal by lines of custom code added, not features shipped.
  Deleting a single-tenant default counts as progress.

## Safety invariants

- Tenant id comes only from unforgeable inputs: signed webhook called-number,
  verified JWT claim, events on our own bus, or a People-table row keyed by a
  channel identity the channel vouches for.
- The tenant is selected before any model runs, and that selection picks the
  credential: in-process tools carry the call's tenant, automations take it
  from the event and name it on every Composio call, and the assistant is
  handed the tenant's own Composio session. Neither the model nor a caller
  ever names a tenant. AgentCore Gateway with Cedar is a per-capability option
  for a model that needs platform tools, not a mandatory hop.
- Every per-tenant resource is addressed by tenant id in its key.
- A missing or unknown tenant fails closed.
- A service acts for a tenant only if that tenant's config enables it.
- Delivery is at-least-once everywhere. A once-marker after success (the
  `checkDone` / `markDone` states in `workflows/asl.ts`) is hardening, not
  exactly-once. Side effects that cost money or reach a customer irreversibly
  get a pending → completed ledger with reconciliation, and that need is the
  trigger for building the ledger.

## Skills

`new-tenant`, `new-tool`, `new-agent` under `.claude/skills/` are
the procedures for the recurring changes. Use them before improvising.
