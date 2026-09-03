# wnkinc_voice

Serverless control layer for an **OpenAI Realtime phone receptionist**.

Twilio owns the number and the SIP transport. Inbound calls are forwarded over a
Twilio Elastic SIP trunk straight into OpenAI Realtime. OpenAI fires a
`realtime.call.incoming` webhook at this backend, which verifies it, maps the
**called number → tenant**, accepts the call with that tenant's model / voice /
instructions / tools, and hands the call to a session Lambda that holds the
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
                              Session Lambda (SQS · one call per invocation)
                            wss://api.openai.com/v1/realtime?call_id=…
                            transcripts → Calls table · function_call → tools
                                                    │
                                       EventBridge bus (wnkinc.voice)
                              lead.recorded · owner.notify · call.ended
                                                    │
                            Notifier Lambda → SES/SNS   CRM-sync Lambda → HubSpot (via Composio)
                                       (later: rule → Temporal workflow starter)
```

## Layout

| Path | What |
|---|---|
| `packages/voice-session/src/webhook.ts` | Lambda: `POST /openai/webhook` — verify, route by called number, claim, accept, enqueue |
| `packages/voice-session/src/session.ts` | Lambda: SQS-triggered, one call per invocation, holds the WebSocket for the call's duration |
| `packages/voice-session/src/call.ts` | One call: `RealtimeSession` + `OpenAIRealtimeSIP` (the OpenAI Agents SDK runs the tool loop); transcripts, time limit, hangup |
| `packages/voice-session/src/agent.ts` | The receptionist: system prompt, the three tools (`record_lead`, `notify_owner`, `end_call`), session config, `accept` payload |
| `packages/voice-session/src/notifier.ts` | Lambda: EventBridge → SES email / SNS SMS |
| `packages/voice-session/src/crm-sync.ts` | Lambda: EventBridge → CRM (lead → contact + note + task; call → transcript note) |
| `packages/shared/src/composio.ts` | Composio adapter: Gmail and HubSpot with the tenant id as the only credential our code names (`CrmAdapter` lives in `shared/src/crm.ts`) |
| `packages/lambda/src/interceptor.ts` | Gateway request interceptor: tenant context from the caller's client identity |
| `packages/shared/src/store.ts` | DynamoDB (tenants, calls, leads) behind one `Store` interface, plus an in-memory version for tests |
| `packages/shared/src/events.ts` | EventBridge publisher |
| `packages/voice-session/src/sip.ts` | Caller/called number extraction from SIP headers |
| `packages/shared/src/types.ts` | `TenantConfig` schema (zod) and record/event types |
| `packages/shared/src/config.ts` | Env vars, Secrets Manager, OpenAI client, JSON logger |
| `packages/assistant/src/` | My Assistant (AgentCore Runtime): `core.ts` one channel-neutral turn with Gateway tools; `telegram.ts` reply delivery; `agent.ts` entrypoint |
| `packages/infrastructure/` | CDK app: `bin/app.ts` + `lib/voice-stack.ts` (NodejsFunction bundles the Lambdas) |
| `scripts/seed-tenant.ts` | Upsert tenant JSON into the Tenants table |
| `tenants/example.json` | Example tenant config |
| `packages/voice-session/test/` | vitest suites (each package carries its own tests) |

## Prerequisites

- Node 22+, AWS CLI configured (CDK bootstrap runs once per account/region: `npx cdk bootstrap`)
- An OpenAI project with Realtime access (note the `proj_…` id under *Settings → Project → General*)
- A Twilio account with a phone number
- (Notifications) an SES-verified sender address; for SMS, an SNS account out of the sandbox

## Deploy

```bash
npm install
npm test
npx cdk bootstrap                           # once per account/region
SES_FROM_EMAIL=alerts@yourdomain.com ALARM_EMAIL=you@yourdomain.com npm run deploy
```

`ALARM_EMAIL` subscribes an address to the alarm topic (confirm the SNS email once). Every
stack's alarms page that topic: dead-letter queues holding anything, and Lambda errors.

Outputs (printed by `npm run deploy`, or `aws cloudformation describe-stacks --stack-name wnk-voice-dev`): `webhookUrl`, `openaiSecretArn`, `tenantsTableName`, `callsTableName`, `leadsTableName`, `eventBusName`, `sessionQueueUrl`, `sessionFunctionName`.

Optional config: `sessionMaxConcurrency` (default 20) — ceiling on simultaneous calls, and therefore on concurrent OpenAI Realtime sessions.

### 1. Configure secrets

The stack creates the secret with placeholder values; nothing works until you set real ones.

```bash
aws secretsmanager put-secret-value \
  --secret-id <openaiSecretArn output> \
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
TENANTS_TABLE=<tenantsTableName output> PEOPLE_TABLE=<peopleTableName output> AWS_REGION=us-west-2 npm run seed -- tenants/example.json
```

Call the number. The webhook Lambda logs every SIP header on each call
(`"msg":"incoming call"`) — check that `to` resolved to your tenant's `phoneNumber`.
With Twilio Elastic SIP Trunking the `To` header carries the OpenAI project id and the
dialed number arrives in `Diversion`; `sip.ts` handles that. If another carrier puts it
elsewhere, add the header name to `CALLED_HEADERS` there, or set `DEFAULT_TENANT_PHONE` on
the webhook Lambda for single-tenant deployments.

## Tenant config

See `TenantConfigSchema` in `packages/shared/src/types.ts`. Key fields:

| Field | Notes |
|---|---|
| `phoneNumber` | E.164, the **called** number; partition key |
| `businessName`, `description`, `services`, `hours`, `timezone` | Fed into the system prompt |
| `agentName`, `greeting`, `extraInstructions` | Persona and tenant-specific rules |
| `model` (default `gpt-realtime-2.1`), `voice` (default `marin`) | Passed to `accept` |
| `tools` | Subset of `record_lead`, `notify_owner`, `end_call` |
| `notifications.email` / `.sms` | Where the notifier delivers |
| `maxCallSeconds` (default 600, max 840) | Agent is asked to wrap up, then the call is hung up |
| `active` | `false` → calls rejected with SIP 603 |
| `crm` | `{ "type": "hubspot", "via": "composio" }` enables CRM sync, caller recognition, and the assistant's CRM tools. The owner consents once (`scripts/connect-composio.mts <id> hubspot`); the token lives in Composio's vault under the tenant id. |
| `cognitoClientId` | The tenant's Gateway identity, minted by the seed; every agent calls the Gateway as this client |
| `products` | Which platform services are on for this tenant: `emailResponder: { enabled, via: "vault" \| "composio" }`, `backOffice: { enabled }`. Default all off; agents refuse to act for a tenant whose flag is off. |

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
6. **Session** — the session Lambda receives the message (one call per invocation) and attaches with the Agents SDK
   (`RealtimeSession` over `OpenAIRealtimeSIP`, the same pattern as OpenAI's
   [realtime-twilio-sip example](https://github.com/openai/openai-agents-js/tree/main/examples/realtime-twilio-sip)).
   It sends a `response.create` that speaks the greeting; the SDK validates and executes
   tool calls and returns results to the model. We log transcripts from the raw events.
   After `end_call` the next response is allowed to finish, audio drains, then we hang up via REST.
7. **Limits** — at `min(tenant.maxCallSeconds, Lambda deadline − 25 s)` the model is told to
   wrap up; hangup follows the next `response.done` (hard stop 20 s later). The Lambda's
   15-minute timeout is the ceiling, hence `maxCallSeconds` maxes at 840.
8. **End** — on socket close the call record gets `status`/`endedAt`, a `call.ended` event
   is published with the full transcript, and the SQS message is deleted by the event
   source mapping.
9. **Failures** — an attach failure is reported as a batch item failure, so the message
   becomes visible again (after the queue's visibility timeout) and the call is retried.
   There is no mid-call re-attach: if an invocation dies, the call drops and the caller
   calls back. A message received 3 times without completing goes to the DLQ.

## Operating: traces, alarms, dead letters

Every Lambda runs with X-Ray active, and the trace is carried by hand across the seams X-Ray
doesn't cross on its own: the SQS message to the session Lambda (`AWSTraceHeader`), the
EventBridge event (`TraceHeader`), and the `InvokeAgentRuntime` call (`traceParent` plus
`baggage` with `tenant_id` and `call_id`). Every log line carries `traceId`, `tenantId`, and
`callId` where known, so one Logs Insights query across the log groups reconstructs a call:

```
fields @timestamp, @log, msg, tenantId, callId
| filter callId = "rtc_..." or traceId = "..."
| sort @timestamp
```

Delivery is at-least-once everywhere (EventBridge, Lambda async retries, SDK retries), so every
event consumer with an external side effect checks a once-marker on the call row before acting
and sets it after success (`Store.isDone` / `markDone`, keys like `notify:lead:<leadId>`,
`crm:call`, `email:lead:<leadId>`). That narrows a duplicate to a crash between the send and the
mark; it is not exactly-once. Anything that costs money or reaches a customer irreversibly
should get a pending → completed ledger with reconciliation instead.

Failures after retries land in a dead-letter queue (session jobs, notifier/CRM events, email
trigger), and each queue has an alarm. The email trigger throws on a non-2xx from the agent,
so a lost lead email is a retried, dead-lettered, alarmed event rather than a log line.

## Operating the session Lambda

```bash
aws logs tail /aws/lambda/wnkinc-voice-dev-session --follow
```

Deploying new session code is `npm run deploy`. Because in-flight calls live inside a Lambda
invocation, a deploy never interrupts them: running invocations finish on the old code,
new calls get the new code.

## CRM (HubSpot through Composio)

Per tenant, opt-in via `crm: { type: "hubspot", via: "composio" }`. The owner approves Composio's
HubSpot app once; no HubSpot token exists anywhere in the platform. Every CRM call names the tenant
(Composio `userId` = our tenant id), so the credential is chosen per call.

- **Gateway tools** (`crm___search_contacts`, `get_contact`, `create_contact`, `add_note`) on the
  platform tools Lambda; the tenant comes from the Gateway interceptor, and a tenant whose row has
  no CRM gets a refusal, never someone else's CRM.
- **`lead.recorded`** → contact upserted by phone, note with the lead, follow-up task due the
  next business morning in the tenant's timezone, assigned to the account's first owner.
- **`call.ended`** → transcript note on the contact, if the caller is already a contact.
- **Caller recognition** — before accepting, the webhook looks the caller ID up (600 ms budget;
  skipped if slow). On a hit, the prompt gets a "Caller ID" section with the name and last note.

A second CRM is another implementation of `CrmAdapter` in `composio.ts` (or a new adapter file)
plus a `type` value. Prove a tenant's connection with `npx tsx scripts/test-crm.mts <id> <phone>`.

## Adding a tool

In `packages/voice-session/src/agent.ts`: add a zod args schema, a handler in `handlers`, and a `tool({...})` entry in
`TOOLS`; then list its name in a tenant's `tools`. The zod schema becomes the function's JSON
schema; `CallContext` gives the handler the tenant, call id, caller number, store, event
publisher and `requestHangup()`.

Tools that need durability (scheduling, follow-ups, approvals) should publish an event
and return immediately; the worker that consumes the event is where a Temporal workflow
starts. The `notifier` Lambda is the v1 stand-in for that worker.

## Tenancy on the tool path

Every agent calls the Gateway as the **tenant's own Cognito app client** (`cognitoClientId` on the
tenant row, minted by the seed script) with the **agent's scope** (`gateway/voice`, `gateway/email`,
`gateway/assistant`). The Gateway validates the JWT by scope, so onboarding a tenant never changes
the gateway or its policies. A request interceptor then maps the validated `client_id` to the
tenant (`byClientId` index) and writes `tenant_id` and `tenant_phone` into every `tools/call`,
overwriting anything the caller sent. Tool schemas carry no tenant fields for the model; Cedar
permits match the scope tag and contain no client or tenant ids. A client no tenant owns is
refused before any tool runs.

The only client without a tenant is the admin/test one (`PLATFORM_CLIENT_IDS`); it passes through
and must name the tenant in its arguments itself.

## My Assistant (Telegram)

A tenant's own people chat with the platform about their business: look up a customer in the
CRM, add a note, ask what the receptionist recorded. One Telegram bot serves every tenant; who is
talking decides the tenant, not which bot.

```
 person ──Telegram──▶ Bot API webhook ──▶ API Gateway (secret path) ──StartExecution──▶ Step Functions
                                                                                          │ not a private text? → done
                                                                                          │ People table GetItem(telegram:<id>)
                                                                                          │ unknown sender? → done, silently
                                                                                          ▼
                                                                          AgentCore Runtime: assistant
                                                                Gateway tools (per tenant row) · Memory · reply via Bot API
```

No Lambda on the path. Identity is Telegram's: the Bot API vouches for the sender's user id, the
People table (seeded from each tenant's `people`) maps it to a tenant and a role, and the workflow
never invokes the agent for anyone else. The agent trusts the payload's tenant the way the voice
tools do — written by our own workflow, from an identity the channel proved — then fails closed on
`products.assistant.enabled`. Tools come from the Gateway catalog, filtered to the targets the
tenant row enables (`crm` for the CRM tools); tenant context is written by the Gateway interceptor from the tenant's identity, never modelled.
The thread lives in the Runtime session (one per chat); facts persist through AgentCore Memory.

The Telegram-shaped code is the reply (`assistant/src/telegram.ts`); SMS later is a second
workflow producing the same payload, and the tenant's `people` entries gain a `phone`.

Setup, once:

1. BotFather → `/newbot` → name it *My Assistant*; copy the token.
2. `aws secretsmanager put-secret-value --secret-id <telegramSecretArn> --secret-string '{"TELEGRAM_BOT_TOKEN":"<token>","WEBHOOK_PATH":"<keep the generated value>"}'`
   (read the current value first; `WEBHOOK_PATH` is generated at deploy and is the webhook's secret).
3. `npx tsx scripts/telegram-webhook.mts set`, then `... info` to confirm no `last_error_message`.

Per person: add them to the tenant file's `people` with their Telegram user id (message the bot once
and read `message.from.id` from the workflow's execution input, or ask @userinfobot), then re-seed.
Removing them from the file and re-seeding removes their access.

Prove it without Telegram: `npx tsx scripts/test-assistant.mts "who is Sarah?"`.

Failure handling: a failed execution (agent 5xx after retries) raises the workflow alarm; the
execution's input is the Telegram update, replayable from the console. A duplicate delivery from
Telegram (only after a lost 200) runs a second turn; the first high-risk tool gets an approval gate
before it ships, not a once-marker.

## Cost & scale notes

- Everything (HTTP API, four Lambdas, DynamoDB, SQS, EventBridge) is on-demand and ~$0 idle;
  per call you pay OpenAI Realtime usage plus Lambda duration for the call's length
  (a 10-minute call at 512 MB is well under a cent).
- Each call is its own invocation with its own 512 MB — the session Lambda holds a socket and
  does JSON, no audio. `sessionMaxConcurrency` (default 20) caps simultaneous calls; the account
  concurrency limit is the hard ceiling.
- There is no mid-call failover: if an invocation dies the call drops and the caller calls back.
  Undelivered jobs wait in SQS up to an hour.
- IaC is AWS CDK (TypeScript, `packages/infrastructure/`); Lambdas are bundled by
  `NodejsFunction` (esbuild) at deploy time.
- Calls table rows expire after 90 days (TTL). All tables use `RemovalPolicy.DESTROY` while this
  is a learning stack; flip to `RETAIN` before real data.

## Roadmap

- Temporal: EventBridge rule → workflow starter for scheduling, callbacks, approvals
- `transfer_call` tool using `POST /calls/{id}/refer`
- Business-hours awareness / after-hours script
- Per-tenant API keys / OpenAI projects if needed for billing isolation
- Admin API for tenant CRUD (today: `npm run seed`)
