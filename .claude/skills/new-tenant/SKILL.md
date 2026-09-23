---
name: new-tenant
description: Onboard a new business (tenant) onto the platform — config row, secrets, OAuth consents, service flags, and the tenant's automations file deployed as its own stack. Use when adding a second (or Nth) business.
---

# Onboard a tenant

A tenant is a config row keyed by their phone number, their credentials under tenant-named keys, and a short file naming the automations they run. The row and secrets never touch a deploy; the automations file is the one deploy, and it deploys that tenant's stack alone (no platform stack, policy, or env change; if a step below seems to need one, something is misfiled). The tenant id threads everything — pick it once, lowercase, short (like `wnk`).

## Steps

1. **Number + trunk**: buy/assign the Twilio number and attach it to the Elastic SIP trunk (Origination `sip:proj_…@sip.api.openai.com;transport=tls`). The webhook routes by CALLED number, so this is what makes calls reach the right tenant.
2. **Config**: create `tenants/<id>.json` (copy `tenants/example.json`; schema = `TenantConfigSchema` in `packages/shared/src/types.ts`). `phoneNumber` is the called number in E.164; `maxCallSeconds` ≤ 840 (Lambda ceiling); `business` holds the facts every service uses; `receptionist` the call agent (its `session` block is passed to OpenAI under those keys); `emailResponder`, `assistant`, `browser` are the service blocks, each with `enabled` — everything defaults to off and agents refuse a tenant whose flag is off. Local overrides can use `tenants/*.local.json` (gitignored).
3. **Seed**: `TENANTS_TABLE=<tenantsTableName output> PEOPLE_TABLE=<peopleTableName output> AWS_REGION=us-west-2 npm run seed -- tenants/<id>.json`. No agent identity is minted per tenant: the tenant is selected upstream of every model (signed called number, People row, bus event) and Composio scopes SaaS by tenant id.
5. **Policy**: nothing. The voice agent's Cedar permit requires tenant context to be *present*, not a specific id — the voice Lambda resolved the tenant from the signed webhook, and that is the trust boundary.
5b. **People** (if `assistant.enabled`): list each person in `people` with `name`, `role` (`owner`|`employee`) and their channels: `telegramId` (they message the bot once; the id is `message.from.id` in the workflow's execution input, or ask @userinfobot) and/or `phone` (their mobile, E.164; they text the tenant's number). The seed mirrors each identity into the People table and removes anyone no longer listed. Unknown senders get silence.
5d. **SMS** (if anyone has a `phone`): the tenant's number must be SMS-capable and A2P 10DLC-registered (Twilio console). Point its messaging webhook at the platform: `npx tsx scripts/twilio-webhook.mts set <id>` (needs the Twilio secret filled once, see README). The reply goes out from the same number.
5c. **HubSpot consent** (if `crm` is set): `npx tsx scripts/connect-composio.mts <id> hubspot` — the owner approves Composio's HubSpot app once; the token lives in Composio's vault under the tenant id. Set `crm: { "type": "hubspot", "via": "composio" }`. Prove with `npx tsx scripts/test-crm-workflows.mts <id> <a known phone>`.
6. **Gmail consent** (if `emailResponder.enabled`): `npx tsx scripts/connect-composio.mts <id>` — the owner approves Composio's Gmail app once; the token lives in Composio's vault under the tenant id.
6c. **Saved browser** (if `browser.enabled`): nothing to set up. The owner sends `/login <site>` to the bot; the reply carries a live view link to sign in and, the first time, a `browser.contextId` to paste into the tenant file. Commit it. Only the owner's Telegram id may send `/login`.

6b. **Assistant tools** (if `assistant.enabled`): list the tools in `assistant.tools`, by name from the catalog in `packages/worker/src/rules/assistant.ts` (`search_contacts`, `add_note`; both need the HubSpot consent above). Nothing is minted and nothing deploys: the seed writes the row and the loop reads it.
6c. **Facebook posts** (if they want to text photos and have the assistant post them to their Page): they need a Facebook Page and admin access to it (not a personal profile). `npx tsx scripts/connect-composio.mts <id> facebook`, ticking the Page on the consent screen; then in the tenant file `"facebookPosts": { "enabled": true, "pageId": "<numeric id>", "pageName": "<name>" }` (both from `FACEBOOK_GET_USER_PAGES` for that tenant) and `draft_facebook_post`, `cancel_facebook_draft` in `assistant.tools`; re-seed. SMS only. Nothing deploys. The person's reply POST publishes, never the model (`packages/worker/src/rules/facebook.ts`).
7. **Memory**: nothing to do — actor ids are `<tenantId>_<phone>`, so the new tenant's caller memory is isolated by construction.
7b. **Automations**: create `tenants/<id>.ts` (copy `tenants/wnk.ts`): the tenant id and the list of automations it runs (`leadEmail`, `crmLead`, `crmCall`, `ownerAlert` from the worker's catalog, each with options if this tenant runs it differently). Add it to `tenants/index.ts`, then `npm run deploy -- wnk-dev-tenant-<id>`. That stack's rules match only events carrying this tenant's id; `test/tenant-stack.test.ts` asserts it. Nothing else deploys: the workflows already run on the worker.
7c. **Telegram connector** (if the tenant wants their Telegram account in their ChatGPT or Claude): `telegramMcp: true` in `tenants/<id>.ts`, then `npm run deploy -- wnk-dev-telegram-mcp-<id>` and fill the tenant-named secret it creates (`wnk-dev/<id>/telegram-mcp`). The steps, with the QR login and the hidden-prompt secret entry, are in `packages/telegram-mcp/README.md`. A tenant who wants only the connector skips everything else here: no number, no row, no seed, `automations: []` (like `tenants/meg.ts`).
8. **Verify**: call the new number; check the webhook log resolved the tenant (`"msg":"incoming call"` → correct `to`); confirm a lead lands with the right `tenantId` and, if enabled, the owner gets the email.

## Varying an automation for one tenant

A tenant's stack holds only that tenant's rules, and the workflows run on the
shared worker, so a change for one tenant is never a branch on the tenant id in
code every tenant runs. Pick the smallest size that is honest about the
difference, in this order:

1. **A value differs** (subject line, task delay, which fields the email shows).
   Give the workflow an options argument with today's behavior as the default,
   and pass it from the tenant's file:
   ```ts
   { workflow: 'leadEmail', options: { subjectPrefix: 'Lead: ' } }
   ```
   Other tenants keep listing `leadEmail` and get the default. The starter hands
   the options to the workflow as its second argument.
2. **A step differs** (skip CRM enrichment, add a step). Same shape: an option
   the workflow reads before the step, tested with the fakes both ways. An
   option, never a check of the tenant id.
3. **The shape differs** (it is really a different automation). Add a workflow
   under its own name as `workflows/automations/<name>.ts`, export it from the
   barrel, register it in `AUTOMATIONS` (`packages/shared/src/contracts.ts`), and list
   that in the tenant's file. The copy owns its future; fixes to the original
   do not reach it.

A new option or workflow is a change to the worker: bump `BUILD_ID`, `npm run deploy --
wnk-dev-worker`, `npm run release`; then the tenant's stack (`npm run deploy -- wnk-dev-tenant-<id>`)
for its rules. `test/tenant-stack.test.ts` renders a tenant file's rules as a table, and the
automation's own test runs it with the option both ways: the change must show only where it was meant.

## Pre-flight

`npx tsx scripts/check-tenant.ts <id>` prints the provisioning checklist
(config drift, secrets, services, owner alert channel, Gmail connection) —
run it after onboarding and any time a tenant misbehaves.

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
