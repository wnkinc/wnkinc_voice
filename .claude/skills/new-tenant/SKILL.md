---
name: new-tenant
description: Onboard a new business (tenant) onto the platform — config row, secrets, OAuth consents, policy scope. Pure data plus one Cedar edit; no new code. Use when adding a second (or Nth) business.
---

# Onboard a tenant

A tenant is data: a config row keyed by their phone number, their credentials in the vault, and their id admitted by Policy. The tenant id threads everything — pick it once, lowercase, short (like `wnk`).

## Steps

1. **Number + trunk**: buy/assign the Twilio number and attach it to the Elastic SIP trunk (Origination `sip:proj_…@sip.api.openai.com;transport=tls`). The webhook routes by CALLED number, so this is what makes calls reach the right tenant.
2. **Config**: create `tenants/<id>.json` (copy `tenants/example.json`; schema = `TenantConfigSchema` in `packages/shared/src/types.ts`). `phoneNumber` is the called number in E.164; `maxCallSeconds` ≤ 840 (Lambda ceiling); local overrides can use `tenants/*.local.json` (gitignored).
3. **Seed**: `TENANTS_TABLE=<tenantsTableName output> AWS_REGION=us-west-2 npm run seed -- tenants/<id>.json`.
4. **CRM secret** (if `crm` is set): the voice stack creates `wnkinc-voice-dev/crm/<id>` placeholders only for ids listed in `lib/voice-stack.ts` (`for (const tenantId of ['wnk'])`) — add the id there, deploy, then `aws secretsmanager put-secret-value` with the real token. Watch for the name-collision-with-deleted-secret error; force-delete the old one if recreating.
5. **Policy**: the voice agent's Cedar permit guards `context.input.tenant_id == "wnk"` in `lib/policy-stack.ts`. Add the new id (e.g. `["wnk", "<id>"].contains(context.input.tenant_id)`) — or, once tenants are plural enough, replace the literal with a claims-vs-input match. Without this, the receptionist's record_lead is DENIED for the new tenant.
6. **OAuth consents** (if the tenant's owner connects Gmail etc.): run the 3LO flow (`scripts/connect-google.ts <userId>`) with a user id namespaced to the tenant.
7. **Memory**: nothing to do — actor ids are `<tenantId>_<phone>`, so the new tenant's caller memory is isolated by construction.
8. **Verify**: call the new number; check the webhook log resolved the tenant (`"msg":"incoming call"` → correct `to`); run `scripts/test-policy.mts` if you touched Cedar; confirm a lead lands with the right `tenantId`.
