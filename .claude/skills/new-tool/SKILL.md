---
name: new-tool
description: Add tools to the Gateway catalog — a new SaaS integration (OpenAPI target + credential provider) or new platform tools (Lambda target). Use when agents need to reach a new API (Salesforce, Slack, calendar) or a new internal capability.
---

# Add a Gateway tool

Tools are data + wiring, not agent code: agents discover them from the catalog. Two shapes.

## SaaS integration (OpenAPI target)

1. **Spec**: add `packages/infrastructure/assets/<vendor>-openapi.json` — only the operations agents need, each with an `operationId` (that becomes the tool name, prefixed `<target>___`). Rules the service enforces: NO `securitySchemes`/`security` sections (auth is configured on the target, never in the spec); static `servers` URL; no oneOf/anyOf/allOf; application/json only.
2. **Credentials** in `lib/identity-stack.ts`:
   - API key: `ApiKeyCredentialProvider` with the key from Secrets Manager via `cdk.SecretValue.secretsManager(...)`.
   - OAuth (3LO): `OAuth2CredentialProvider.using<Vendor>(...)`; output its `callbackUrl` and register it in the vendor's OAuth app; run a consent flow (print the authorization URL, poll the session, prove the token with one API read). For SaaS with a Composio integration, prefer `scripts/connect-composio.mts` and the Composio adapter instead.
3. **Target** in `lib/gateway-stack.ts`: `gateway.addOpenApiTarget(...)` with the credential provider. CRITICAL for Bearer APIs: pass an explicit `ApiKeyCredentialLocation.header({ credentialParameterName: 'Authorization', credentialPrefix: 'Bearer' })` — NO trailing space; the CDK default `'Bearer '` plus the service's own joining space produces `Bearer  <key>` and an upstream 401.
4. **Policy**: no agent can call the new tools until a Cedar permit names them (new-policy skill).
5. **Prove it**: `scripts/test-gateway.ts` lists tools; call one through the gateway as the admin client. If a call returns "internal error", read `/wnk/agentcore/gateway` logs for the upstream response; if still opaque, point a temporary echo target (httpbin `/anything`) at the same credential provider to see exactly what the gateway sends.

## Platform tools (Lambda target)

1. Handler in `packages/lambda/src/` — the Gateway passes tool args as the event and the tool name in `context.clientContext.custom.bedrockAgentCoreToolName` (`<target>___<tool>`). Tenant context (`tenant_id`, `tenant_phone`) is written into the args by the Gateway's request interceptor from the caller's identity (declare the fields in the schema, never mark them required); other context (`call_id`, …) is injected by the calling agent. The model never supplies any of it, and Cedar guards `context.input has tenant_id`. SaaS credentials are chosen per call by tenant id (Composio) — never attach a credential to a target.
2. The Lambda lives in `lib/voice-stack.ts` (it owns the tables/bus it touches); the target registration lives in `lib/gateway-stack.ts` via `addLambdaTarget` with an inline `ToolSchema` + `grantInvoke(gateway.role)`.
3. Same policy + proof steps as above.
