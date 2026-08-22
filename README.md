# wnkinc_voice

Serverless control layer for an **OpenAI Realtime phone receptionist**.

Twilio owns the number and the SIP transport. Inbound calls are forwarded over a
Twilio Elastic SIP trunk straight into OpenAI Realtime. OpenAI fires a
`realtime.call.incoming` webhook at this backend, which verifies it, maps the
**called number → tenant**, accepts the call with that tenant's model / voice /
instructions / tools, and hands the call to a small EC2 worker that holds the
WebSocket and executes tool calls (record a lead, notify the owner, end the
call). One deployment serves many businesses.

```
 caller ──PSTN──▶ Twilio number ──SIP trunk──▶ OpenAI Realtime (audio stays here)
                                                    │
                                  realtime.call.incoming webhook
                                                    ▼
                     API Gateway (HTTP) ──▶ Webhook Lambda
                       verify sig · To-number → tenant (DynamoDB) · claim call_id
                       POST /v1/realtime/calls/{id}/accept {model, voice, instructions, tools}
                                                    │ SQS
                                                    ▼
                                   Session worker (EC2 t4g.nano, systemd)
                            wss://api.openai.com/v1/realtime?call_id=…
                            transcripts → Calls table · function_call → tools
                                                    │
                                       EventBridge bus (wnkinc.voice)
                              lead.recorded · owner.notify · call.ended
                                                    │
                            Notifier Lambda → SES/SNS   CRM-sync Lambda → HubSpot
                                       (later: rule → Temporal workflow starter)
```

## Layout

| Path | What |
|---|---|
| `src/webhook.ts` | Lambda: `POST /openai/webhook` — verify, route by called number, claim, accept, enqueue |
| `src/worker.ts` | EC2 worker: long-polls SQS, runs one call per message, re-attaches after restarts |
| `src/call.ts` | One call: `RealtimeSession` + `OpenAIRealtimeSIP` (the OpenAI Agents SDK runs the tool loop); transcripts, time limit, hangup, detach |
| `src/agent.ts` | The receptionist: system prompt, the three tools (`record_lead`, `notify_owner`, `end_call`), session config, `accept` payload |
| `src/notifier.ts` | Lambda: EventBridge → SES email / SNS SMS |
| `src/crm-sync.ts` | Lambda: EventBridge → CRM (lead → contact + note + task; call → transcript note) |
| `src/hubspot.ts` | HubSpot REST client behind a small `CrmAdapter` interface |
| `src/store.ts` | DynamoDB (tenants, calls, leads) behind one `Store` interface, plus an in-memory version for tests |
| `src/events.ts` | EventBridge publisher |
| `src/sip.ts` | Caller/called number extraction from SIP headers |
| `src/types.ts` | `TenantConfig` schema (zod) and record/event types |
| `src/config.ts` | Env vars, Secrets Manager, OpenAI client, JSON logger |
| `infra/` | Pulumi program (`index.ts`) + esbuild bundling (`bundle.ts`) |
| `scripts/seed-tenant.ts` | Upsert tenant JSON into the Tenants table |
| `tenants/example.json` | Example tenant config |
| `test/` | vitest suites |

## Prerequisites

- Node 22+, AWS CLI configured, Pulumi CLI (`brew install pulumi`) logged in to a backend (`pulumi login`)
- An OpenAI project with Realtime access (note the `proj_…` id under *Settings → Project → General*)
- A Twilio account with a phone number
- (Notifications) an SES-verified sender address; for SMS, an SNS account out of the sandbox

## Deploy

```bash
npm install
npm test
pulumi stack init dev                       # once
pulumi config set sesFromEmail alerts@yourdomain.com
pulumi up                                   # bundles the handlers with esbuild and deploys
```

Outputs (`pulumi stack output`): `webhookUrl`, `openaiSecretArn`, `tenantsTableName`, `callsTableName`, `leadsTableName`, `eventBusName`, `sessionQueueUrl`, `workerInstanceId`, `workerLogGroupName`.

Optional config: `workerInstanceType` (default `t4g.nano`), `workerMaxCalls` (default 20).

### 1. Configure secrets

The stack creates the secret with placeholder values; nothing works until you set real ones.

```bash
aws secretsmanager put-secret-value \
  --secret-id $(pulumi stack output openaiSecretArn) \
  --secret-string '{"OPENAI_API_KEY":"sk-...","OPENAI_WEBHOOK_SECRET":"whsec_..."}'
```

(`OPENAI_WEBHOOK_SECRET` comes from step 2 — create the webhook first, then write both values.)

### 2. Register the webhook with OpenAI

platform.openai.com → *Settings → Project → Webhooks* → add the `webhookUrl` output subscribed to
`realtime.call.incoming`. Copy the signing secret into the secret above.

### 3. Point Twilio at OpenAI

Twilio Console → *Elastic SIP Trunking → Trunks → Create*:

- **Origination** URI: `sip:proj_XXXXXXXX@sip.api.openai.com;transport=tls`
  (EU data residency: `sip-eu.api.openai.com`)
- **Numbers**: attach the phone number(s) you want answered
- Leave **Termination** alone.

### 4. Seed a tenant

Edit `tenants/example.json` (one object per *called* number) and:

```bash
TENANTS_TABLE=$(pulumi stack output tenantsTableName) npm run seed -- tenants/example.json
```

Call the number. The webhook Lambda logs every SIP header on each call
(`"msg":"incoming call"`) — check that `to` resolved to your tenant's `phoneNumber`.
With Twilio Elastic SIP Trunking the `To` header carries the OpenAI project id and the
dialed number arrives in `Diversion`; `src/sip.ts` handles that. If another carrier puts it
elsewhere, add the header name to `CALLED_HEADERS` there, or set `DEFAULT_TENANT_PHONE` on
the webhook Lambda for single-tenant deployments.

## Tenant config

See `TenantConfigSchema` in `src/types.ts`. Key fields:

| Field | Notes |
|---|---|
| `phoneNumber` | E.164, the **called** number; partition key |
| `businessName`, `description`, `services`, `hours`, `timezone` | Fed into the system prompt |
| `agentName`, `greeting`, `extraInstructions` | Persona and tenant-specific rules |
| `model` (default `gpt-realtime-2.1`), `voice` (default `marin`) | Passed to `accept` |
| `tools` | Subset of `record_lead`, `notify_owner`, `end_call` |
| `notifications.email` / `.sms` | Where the notifier delivers |
| `maxCallSeconds` (default 600, max 1740) | Agent is asked to wrap up, then the call is hung up |
| `active` | `false` → calls rejected with SIP 603 |
| `crm` | `{ "type": "hubspot" }` enables CRM sync + caller recognition; token in Secrets Manager at `<stack>/crm/<tenantId>` |

Unknown numbers are rejected with SIP 404.

## How a call flows

1. **Webhook** — `openai.webhooks.unwrap` verifies the signature (bad → 400). Non-call
   events are acknowledged and ignored.
2. **Route** — `identifyParties` reads `To`/`From`; the Tenants table is keyed by called number.
3. **Claim** — a conditional `PutItem` on the Calls table makes webhook retries idempotent
   (OpenAI retries non-2xx for up to 72 h). A claim in status `failed` can be re-claimed so a
   transient `accept` failure (→ 500) is retried by OpenAI.
4. **Accept** — `POST /v1/realtime/calls/{id}/accept` with the tenant's session config:
   instructions, voice, semantic VAD with interruption, far-field noise reduction,
   `gpt-4o-mini-transcribe` input transcription, and function tools.
5. **Hand off** — the webhook puts a `SessionJob` on the SQS queue and returns 200.
6. **Session** — the EC2 worker receives the message and attaches with the Agents SDK
   (`RealtimeSession` over `OpenAIRealtimeSIP`, the same pattern as OpenAI's
   [realtime-twilio-sip example](https://github.com/openai/openai-agents-js/tree/main/examples/realtime-twilio-sip)).
   It sends a `response.create` that speaks the greeting; the SDK validates and executes
   tool calls and returns results to the model. We log transcripts from the raw events.
   After `end_call` the next response is allowed to finish, audio drains, then we hang up via REST.
7. **Limits** — at `min(tenant.maxCallSeconds, 29 min)` the model is told to wrap up; hangup
   follows the next `response.done` (hard stop 20 s later). OpenAI caps sessions at 30 min.
8. **End** — on socket close the call record gets `status`/`endedAt`, a `call.ended` event
   is published with the full transcript, and the SQS message is deleted.
9. **Restarts** — the message is only deleted when the call ends. If the worker is restarted
   (deploy, crash, SIGTERM) it `detach()`es live sockets and releases their messages; the next
   worker re-attaches to the same `call_id` and skips the greeting. A message received 5 times
   without completing goes to the DLQ.

## Operating the worker

```bash
aws ssm start-session --target $(pulumi stack output workerInstanceId)   # shell, no SSH/inbound ports
sudo systemctl status wnkinc-voice-worker
sudo journalctl -u wnkinc-voice-worker -f                                  # or the CloudWatch group below
aws logs tail $(pulumi stack output workerLogGroupName) --follow
```

Deploying new worker code is `pulumi up`: the bundle is uploaded to S3 and the instance is
replaced (its user data embeds the bundle hash). Calls in progress are re-attached by the new
instance within ~a minute of it booting. The AMI is pinned via `ignoreChanges` so AL2023
releases don't churn the instance; remove that line to roll forward deliberately.

## CRM (HubSpot)

Per tenant, opt-in via `crm: { type: "hubspot" }`. Credentials are a JSON secret
`{"HUBSPOT_TOKEN":"pat-na1-..."}` at `wnkinc-voice-<stack>/crm/<tenantId>` (a HubSpot
**Service Key** with contacts + companies read/write and owners read). `infra/index.ts` creates
the placeholder secret per tenant id listed there.

- **`lead.recorded`** → contact upserted by phone, note with the lead, follow-up task due the
  next business morning in the tenant's timezone, assigned to the account's first owner.
- **`call.ended`** → transcript note on the contact, if the caller is already a contact.
- **Caller recognition** — before accepting, the webhook looks the caller ID up (600 ms budget;
  skipped if slow). On a hit, the prompt gets a "Caller ID" section with the name and last note,
  and the agent is told to confirm who it's speaking with before using it.

A second CRM is another implementation of `CrmAdapter` in a new file plus a `type` value.

## Adding a tool

In `src/agent.ts`: add a zod args schema, a handler in `handlers`, and a `tool({...})` entry in
`TOOLS`; then list its name in a tenant's `tools`. The zod schema becomes the function's JSON
schema; `CallContext` gives the handler the tenant, call id, caller number, store, event
publisher and `requestHangup()`.

Tools that need durability (scheduling, follow-ups, approvals) should publish an event
and return immediately; the worker that consumes the event is where a Temporal workflow
starts. The `notifier` Lambda is the v1 stand-in for that worker.

## Cost & scale notes

- Fixed cost is the worker: t4g.nano ≈ $3/mo + 8 GB gp3 ≈ $0.64 + public IPv4 ≈ $3.65 → **≈ $7.50/mo**.
  Everything else (HTTP API, two Lambdas, DynamoDB, SQS, EventBridge) is on-demand and ~$0 idle;
  per call you pay OpenAI Realtime usage.
- One t4g.nano (512 MB) comfortably runs dozens of concurrent calls — the worker holds sockets and
  does JSON, no audio. `workerMaxCalls` caps it; bump `workerInstanceType` to `t4g.micro` for headroom.
- The worker is a single instance in one AZ. If it is down, OpenAI still answers calls with the
  tenant's instructions, but tools and transcripts resume only when the worker is back (jobs wait in
  SQS up to an hour).
- IaC is Pulumi (TypeScript, `infra/index.ts`); Lambdas and the worker are bundled by esbuild at
  `pulumi up` time into `infra/.build/`.
- Calls table rows expire after 90 days (TTL); tenants and leads are `protect`ed from `pulumi destroy`
  (`pulumi config set retainData false` to change).

## Roadmap

- Temporal: EventBridge rule → workflow starter for scheduling, callbacks, approvals
- `transfer_call` tool using `POST /calls/{id}/refer`
- Business-hours awareness / after-hours script
- Per-tenant API keys / OpenAI projects if needed for billing isolation
- Admin API for tenant CRUD (today: `npm run seed`)
