# wnkinc_voice — working agreements

Read the README for what the system is and how it runs. This file holds the goals
that decide *how* to change it.

## Two governing goals

1. **The smallest amount of custom code that offers multiple services safely
   across multiple tenants.**
2. **Thin product code on top of thick rented infrastructure.** Managed services
   (AgentCore Gateway/Identity/Policy/Memory/Runtime/Browser, Cognito, DynamoDB,
   EventBridge, Composio, OpenAI Realtime, Twilio) carry the enforcement. Custom
   code only resolves tenant identity, threads it through, and fails closed.

Why: this is a solo-built platform. Every line of custom code is maintenance and
a place tenancy can leak. Rented infra is where the isolation and auth guarantees
should live.

## How to apply

- Before proposing code, ask whether a managed service, a config row, or a CDK
  declaration can do it instead. Prefer data > declarative config > code.
- Tenant data (anything that differs between two customers) belongs in the tenant
  row, a tenant-named secret, or a vault keyed by tenant id. Never in CDK, env
  vars, Cedar literals, or `?? 'wnk'` fallbacks.
- Build deferred items only when their trigger fires. The `new-tenant` skill keeps
  the trigger list. Don't pre-build membership models, per-tenant KMS keys, or
  config lineage.
- Measure a proposal by lines of custom code added, not features shipped.
  Deleting a single-tenant default counts as progress.

## Safety invariants

- Tenant id comes only from unforgeable inputs: signed webhook called-number,
  verified JWT claim, events on our own bus, or the Gateway interceptor mapping
  the caller's validated client identity to its tenant.
- On the tool path, tenant context is written by the Gateway interceptor from
  the caller's identity, never by the model and not by agent code. An agent
  acts for a tenant by calling the Gateway as that tenant's own client.
- Every per-tenant resource is addressed by tenant id in its key.
- A missing or unknown tenant fails closed.
- A service acts for a tenant only if that tenant's config enables it.
- Delivery is at-least-once everywhere. A once-marker after success
  (`Store.isDone` / `markDone`) is hardening, not exactly-once. Side effects that
  cost money or reach a customer irreversibly get a pending → completed ledger
  with reconciliation, and that need is the trigger for building the ledger.

## Skills

`new-tenant`, `new-tool`, `new-agent`, `new-policy` under `.claude/skills/` are
the procedures for the recurring changes. Use them before improvising.
