---
name: new-tenant
description: Onboard a new business (tenant) onto the platform — config row, secrets, OAuth consents, service flags. Pure data, zero deploys, no code. Use when adding a second (or Nth) business.
---

# Onboard a tenant

A tenant is data: a config row keyed by their phone number and their credentials under tenant-named keys. Onboarding is zero-deploy — no stack, policy, or env change; if a step below seems to need one, something is misfiled. The tenant id threads everything — pick it once, lowercase, short (like `wnk`).

## Steps

1. **Number + trunk**: buy/assign the Twilio number and attach it to the Elastic SIP trunk (Origination `sip:proj_…@sip.api.openai.com;transport=tls`). The webhook routes by CALLED number, so this is what makes calls reach the right tenant.
2. **Config**: create `tenants/<id>.json` (copy `tenants/example.json`; schema = `TenantConfigSchema` in `packages/shared/src/types.ts`). `phoneNumber` is the called number in E.164; `maxCallSeconds` ≤ 840 (Lambda ceiling); `products` says which services are on (`emailResponder.enabled`, `assistant.enabled`) — everything defaults to off and agents refuse a tenant whose flag is off. Local overrides can use `tenants/*.local.json` (gitignored).
3. **Seed**: `TENANTS_TABLE=<tenantsTableName output> PEOPLE_TABLE=<peopleTableName output> AWS_REGION=us-west-2 npm run seed -- tenants/<id>.json`. No agent identity is minted per tenant: the tenant is selected upstream of every model (signed called number, People row, bus event) and Composio scopes SaaS by tenant id.
5. **Policy**: nothing. The voice agent's Cedar permit requires tenant context to be *present*, not a specific id — the voice Lambda resolved the tenant from the signed webhook, and that is the trust boundary.
5b. **People** (if `products.assistant.enabled`): list each person in `people` with `name`, `role` (`owner`|`employee`) and their `telegramId` (they message the bot once; the id is `message.from.id` in the workflow's execution input, or ask @userinfobot). The seed mirrors them into the People table and removes anyone no longer listed. Unknown senders get silence.
5c. **HubSpot consent** (if `crm` is set): `npx tsx scripts/connect-composio.mts <id> hubspot` — the owner approves Composio's HubSpot app once; the token lives in Composio's vault under the tenant id. Set `crm: { "type": "hubspot", "via": "composio" }`. Prove with `npx tsx scripts/test-crm-workflows.mts <id> <a known phone>`.
6. **Gmail consent** (if `products.emailResponder.enabled`): `npx tsx scripts/connect-composio.mts <id>` — the owner approves Composio's Gmail app once; the token lives in Composio's vault under the tenant id.
6c. **Saved browser** (if `products.browser.enabled`): nothing to set up. The owner sends `/login <site>` to the bot; the reply carries a live view link to sign in and, the first time, a `browserContextId` to paste into the tenant file. Commit it. Only the owner's Telegram id may send `/login`.

6b. **Assistant tools** (if `products.assistant.enabled`): re-run the seed with `COMPOSIO_SECRET_ARN` set AFTER the consents above; it mints the tenant's Composio meta-tools MCP session bound to those connected accounts and writes `composioMcpUrl` into the file. Commit it. To change which toolkits the assistant sees, delete the field and reseed after connecting/disconnecting accounts.
7. **Memory**: nothing to do — actor ids are `<tenantId>_<phone>`, so the new tenant's caller memory is isolated by construction.
8. **Verify**: call the new number; check the webhook log resolved the tenant (`"msg":"incoming call"` → correct `to`); confirm a lead lands with the right `tenantId` and, if enabled, the owner gets the email.

## Pre-flight

`npx tsx scripts/check-tenant.ts <id>` prints the provisioning checklist
(config drift, secrets, services, owner alert channel, Gmail connection) —
run it after onboarding and any time a tenant misbehaves.

`npx tsx scripts/tenant-profile.ts <id>` writes the tenant's service profile to `tenant-profiles/<id>.md` (gitignored)
in plain language (what they get, derived from the row with the workflows'
own gates) — hand it to the customer or read it before a support call.

## Deliberately deferred (build when the trigger fires, not before)

- **Membership model** (one person, many businesses; workspace switching):
  trigger = the first human who belongs to two tenants. Until then the
  tenant row's `people` list (mirrored into the People table) is the whole model. (Dify's shape:
  tenant_account_joins with a `current` flag, tenant resolved from the DB
  per request — never from the token.)
- **Per-tenant encryption keys**: trigger = a customer contractually
  requiring their own key. The AWS-native answer is a KMS CMK per tenant
  (~$1/mo each), not hand-rolled keypairs. Secrets Manager + the AgentCore
  vault already encrypt at rest.
- **Config lineage** (draft -> immutable snapshot -> revision audit):
  trigger = the first config edit that happens OUTSIDE git (console edit
  button, agent self-service). Until then git IS the lineage. (Dify's
  shape: AgentConfigDraft / AgentConfigSnapshot / AgentConfigRevision.)
