# wnkinc_voice

A multi-tenant platform that answers a small business's phone, remembers its callers, and
lets its people talk to the business over chat. One deployment serves many businesses; a
business is a config row plus a short file naming the automations it runs.

Three things can happen, and each is its own system:

- **A phone call comes in** → the receptionist. OpenAI Realtime answers as that business,
  takes a lead, alerts the owner if it is urgent, and after hang-up the call is remembered,
  metered, and handed to whatever automations the tenant runs.
- **A message comes in, on Telegram or by text** → the business assistant. A person the
  tenant listed chats with the business: look up a customer, add a note, ask what the
  receptionist recorded. `/login` from the owner on Telegram opens the tenant's saved
  browser instead.
- **The clock hits 15:00 UTC** → the health checks. Every tenant's connections and
  assistant are proven live before a customer finds out they are not.

A tenant starts with the receptionist. Optional capabilities are enabled on top of it:
CRM sync, a lead email from the owner's Gmail, the assistant, the saved browser.

The platform is thin custom code on thick rented infrastructure. Two Lambdas are code
(the webhook verifier and the session that holds a call). Everything else is a Step
Functions definition or a CDK declaration. See `CLAUDE.md` for the
goals that decide how to change it.

## 1. Platform: what every tenant gets

### A phone call comes in

```
 caller ──PSTN──▶ Twilio number ──SIP trunk──▶ OpenAI Realtime (audio stays here)
                                                    │
                                  realtime.call.incoming webhook
                                                    ▼
                     API Gateway (HTTP) ──▶ verifier Lambda (signature only)
                                                    │ StartExecution
                     accept workflow (Step Functions, no code): SIP headers → called number →
                       tenant row · claim call_id · POST /v1/realtime/calls/{id}/accept {model, voice}
                       · caller recognition (CRM note, memory) · job to SQS
                                                    │ SQS
                                                    ▼
                              Session Lambda (SQS · one call per invocation)
                            wss://api.openai.com/v1/realtime?call_id=…
                            transcripts → Calls table · function_call → tools
                                                    │
                                       EventBridge bus (wnkinc.voice)
                              lead.recorded · owner.notify · call.ended
                                                    │
                       platform (runtime stack), the same for every tenant:
                        call.ended    → transcript to caller memory, minutes to usage
                       per tenant, in that tenant's stack, rules filtered on its id:
                        lead.recorded → HubSpot contact + note + task (via Composio HTTP)
                        lead.recorded → CRM + memory → owner's Gmail
                        call.ended    → transcript note on the HubSpot contact
                        owner.notify  → owner on Telegram
```

Three phases: get the call in safely (verify, accept), run the receptionist (session), do
the after-call work (memory and usage always; the rest per tenant, see section 2).

1. **Verify** — the verifier Lambda checks the Standard-Webhooks HMAC over the raw body
   (bad → 400) and starts the accept workflow with the body; it answers 200 at once.
2. **Route** — the accept workflow parses `To`/`Diversion`/`From` from the SIP headers; the
   Tenants table is keyed by called number. Unknown number: reject 404 and fail (alarm);
   inactive tenant: reject 603. There is no default tenant.
3. **Claim** — a conditional `PutItem` on the Calls table makes webhook retries idempotent
   (OpenAI re-posts on non-2xx). A claim in status `failed` can be re-claimed.
4. **Accept** — `POST /v1/realtime/calls/{id}/accept` with the minimum: model, voice, and a
   hold instruction. The session Lambda sends the full config (instructions, semantic VAD,
   noise reduction, transcription, function tools) when it attaches.
5. **Recognize and hand off** — the workflow looks the caller up in the tenant's CRM (last
   note) and in memory, with a real time budget, and puts a `SessionJob` on the SQS queue.
   On a hit, the prompt gets a "Caller ID" section with the name and last note.
6. **Session** — the session Lambda receives the message (one call per invocation) and attaches with the Agents SDK
   (`RealtimeSession` over `OpenAIRealtimeSIP`, the same pattern as OpenAI's
   [realtime-twilio-sip example](https://github.com/openai/openai-agents-js/tree/main/examples/realtime-twilio-sip)).
   It sends a `response.create` that speaks the greeting; the SDK validates and executes
   tool calls and returns results to the model. We log transcripts from the raw events.
   The three tools are `record_lead` (one publish: `lead.recorded`), `notify_owner` (one
   publish: `owner.notify`), and `end_call`. After `end_call` the next response is allowed
   to finish, audio drains, then we hang up via REST.
7. **Limits** — at `min(tenant.maxCallSeconds, Lambda deadline − 25 s)` the model is told to
   wrap up; hangup follows the next `response.done` (hard stop 20 s later). The Lambda's
   15-minute timeout is the ceiling, hence `maxCallSeconds` maxes at 840.
8. **End** — on socket close the call record gets `status`/`endedAt`, a `call.ended` event
   (ids and outcome; the transcript stays on the row) is published, and the SQS message is
   deleted by the event source mapping. The call-ended workflow writes the transcript to the
   caller's memory and meters the minutes.
9. **Failures** — an attach failure is reported as a batch item failure and the message
   dead-letters at once (a retry after the 16-minute visibility timeout would reach a call
   that ended long ago); the DLQ alarms. There is no mid-call re-attach: if an invocation
   dies, the call drops and the caller calls back.

### A message comes in: Telegram or SMS

Two front doors to one assistant. One Telegram bot serves every tenant; who is talking decides
the tenant, not which bot. For SMS, a person texts their own business's number (the same Twilio
number the receptionist answers), and the sender's number is the identity.

```
 person ──Telegram──▶ Bot API webhook ──▶ API Gateway (secret path) ──StartExecution──▶ Step Functions
                                                                                          │ not a private text? → done
                                                                                          │ People GetItem(telegram:<id>) → Tenants GetItem
                                                                                          │ unknown sender / assistant off? → done, silently
                                                                                          │ /login from the owner? → browser-login workflow
                                                                                          ▼
                                                              the agent loop (workflows/assistant/assistant-loop.ts):
                                                    Memory: this session's history + what it recalls about the person
                                                    ──▶ OpenAI Responses (HTTP task) ──▶ tool call? gate it, run it through
                                                        Composio AS the tenant, back to the model ──▶ ... until it answers
                                                                                          │ PutEvents telegram.reply · Memory: save the turn
                                                                                          ▼
                                                                    EventBridge API destination → Bot API sendMessage
```

**No code and no runtime on the path.** The agent loop is states inside the workflow
(`workflows/assistant/assistant-loop.ts`, shared by the Telegram and SMS workflows and the canary). The model
makes every judgment: which tool, what arguments, when to stop. The states between its decisions are
mechanical, and they are the seam the platform controls: the tool must be on the tenant row's
`assistant.tools` list, every Composio call names the tenant, tool results are bounded, rounds are
capped at six, and each call is a line in the execution history. Rounds inside one turn chain with
OpenAI's `previous_response_id`, so a later round sends only the tool results. Tools are a catalog in
the loop file: what the model sees is a slim schema (`search_contacts(query)`), what runs is a Composio
slug with defaults. Adding a tool is one catalog entry and a name on the rows that get it.

Memory is the platform Memory instance: at the start of a turn the loop reads this session's earlier
turns and retrieves what the service has extracted about the person (facts, preferences, summaries);
at the end it writes the turn back, and extraction happens on its own. Each person gets a fresh
session per day, rolling at 3 AM in the tenant's timezone (`sessionDayOffsetMinutes`, computed by the
seed; drifts an hour across DST until the next seed). The reply goes out through an EventBridge API
destination whose endpoint holds the bot token (resolved from the Telegram secret at deploy); failures
land in a dead-letter queue with an alarm. Replies over Telegram's 4096-character limit fail there —
the prompt asks for brevity; splitting is deferred until it is actually needed.

Identity is Telegram's: the Bot API vouches for the sender's user id, the People table (seeded from
each tenant's `people`) maps it to a tenant and a role, and the workflow never runs the loop for
anyone else. The same reply path carries the receptionist's owner alerts.

Prove it end to end: `npx tsx scripts/test-assistant.mts "who is Sarah?" <tenantId>` starts the
Telegram workflow as the tenant's owner; the reply lands on their Telegram and is printed.

**SMS.** Twilio posts each inbound text to a secret path on the same API. Twilio sends a
form-encoded body, which is not JSON and so cannot start a state machine directly, so the route
puts the raw string on a queue and an EventBridge Pipe starts the SMS workflow (`workflows/assistant/sms.ts`)
with it; the workflow's first state parses it. The People lookup is `sms:<sender>`, plus one check
Telegram cannot make: the number texted must be that person's tenant's number. From there it is the
Telegram path: the same loop, a session per phone per day, an actor
per person (`<tenant>_sms_<digits>`, separate from the caller memory of whoever phones from that
number). The reply is an HTTP task inside the workflow straight to Twilio's Messages API, form-encoded
through a basic-auth Connection, addressed with the account SID the inbound post carried. A reply
over Twilio's 1600 characters fails the execution and alarms; the prompt asks for far less. Only the
number-level messaging webhook is configured; a number sending through a Messaging Service takes its
inbound webhook from the service.

**Saved browser: `/login`.** A business signs into the sites it uses once, and the platform keeps
that browser. The owner sends `/login <site>` to the bot; the Telegram workflow starts the
browser-login workflow (`workflows/assistant/browser-login.ts`) instead of the assistant. It opens a Browserbase
session on the tenant's context (the saved browser: cookies and logins, encrypted in Browserbase's
vault, keyed on the row as `browser.contextId`), sends the owner the interactive live view link, waits
ten minutes, and releases the session so the context syncs. One window at a time per tenant: two
sessions on one context race on release and the later one overwrites the earlier one's logins, so the
row carries the window's end (`browser.loginUntil`) and a second `/login` meanwhile is answered, not
started. Captcha solving is Browserbase's, on by default. The windowed live view has an address bar;
the owner types the site's URL there. Only the owner's Telegram id may send `/login`, and only for a
tenant with `browser.enabled`. What the assistant does with that browser is step two (a per-tenant
Stagehand session); today nothing but the owner drives it.

### The clock hits 15:00 UTC

Silent degradation gets a canary. Two run daily, ten minutes apart so a failure in the second is
about the loop and not about Composio:

- **15:00, `composio-health`** scans the Tenants table and asks Composio for each tenant's ACTIVE
  connected accounts, expecting HubSpot when `crm.via` is composio, Gmail when the email responder
  is on, and at least one when the assistant is on. A missing connection would otherwise fail
  nothing (every CRM and Gmail state catches and carries on); here it fails the execution, which
  alarms with the tenant and the reconnect command.
- **15:10, `assistant-health`** runs the same loop for each enabled tenant with one read-only
  question (a phone number no contact has) and asserts only that it produced text. It proves the model
  answers through the OpenAI Connection, Memory reads and writes, and a tool call reaches Composio and
  comes back. Nobody messages the bot on a quiet week, so this is the traffic that proves it still works.

### How the tenant is chosen

There is no Gateway hop. The tenant is selected **before any model runs**, from an unforgeable
input, and that selection picks the credential:

- **Receptionist**: the webhook resolves the tenant from the signed called number; the two
  tools (`record_lead`, `notify_owner`) run in-process with that call context and are one write or
  one publish each. Everything multi-step is a consumer of the events they publish.
- **Tenant automations** (CRM sync, lead email, owner alert): no code, no model. Each is that
  tenant's own state machine in that tenant's stack, started by a rule that matches only events
  carrying the tenant's id (published by our own session Lambda). It reads the tenant row by the
  event's phone number; every Composio HTTP call names that tenant as Composio's user, and the
  owner alert delivers to the owner listed on the row.
- **Assistant**: the People table maps the Telegram sender id, or the texting phone number, to a
  tenant; the loop runs each tool the model asks for through Composio naming that tenant, and only
  tools on the tenant row's list. The model's tools cannot reach another tenant's SaaS because no
  state ever names one. Both channels' posts arrive on a secret path only the channel knows.

Neither a model nor a caller ever names a tenant. AgentCore Gateway with Cedar is the option for the
day an open-ended model needs a *platform* tool, or a SaaS Composio does not broker needs OAuth in
front of it — a capability-by-capability choice, not a mandatory layer (last shape: commit 832360b).

## 2. Tenant: the row and the automations file

A tenant is two things. The **row** (`tenants/<id>.json`, seeded into the Tenants table) holds
everything that differs between two businesses: number, persona, people, flags, connections. The
**automations file** (`tenants/<id>.ts`) names which after-call automations the tenant runs and
deploys as that tenant's own stack. The row never touches a deploy; the file is the one deploy,
and it deploys that tenant alone. The `new-tenant` skill is the onboarding procedure.

### The row

See `TenantConfigSchema` in `packages/shared/src/types.ts`. Key fields:

| Field | Notes |
|---|---|
| `phoneNumber` | E.164, the **called** number; partition key |
| `active` | `false` → calls rejected with SIP 603 |
| `business` | `name`, `description`, `services`, `hours`, `timezone`: the facts every service draws on (receptionist prompt, assistant prompt, lead email, CRM notes) |
| `people` | The tenant's own people with their channel ids: `telegramId`, `phone` (E.164, for SMS), or both. `notify_owner` alerts go to the person with role `owner` and a `telegramId`; the assistant answers anyone listed, on whichever channel they have. |
| `receptionist.session` | Passed to OpenAI Realtime under these same keys: `model` (default `gpt-realtime-2.1`), `audio.output.voice` (default `marin`), `tools` (subset of `record_lead`, `notify_owner`, `end_call`). Levers not yet built are listed in `packages/receptionist/README.md` |
| `receptionist.instructions` | What the platform composes into the prompt alongside `business`: `agentName` (default `Alex`), `extra` (tenant-specific rules) |
| `receptionist.greeting` | Spoken verbatim on connect, through a separate response request |
| `receptionist.maxCallSeconds` (default 600, max 840) | Ours, not OpenAI's: the agent is asked to wrap up, then the call is hung up |
| `crm` | `{ "type": "hubspot", "via": "composio" }` enables caller recognition, CRM sync, and the assistant's CRM tools. The owner consents once (`scripts/connect-composio.mts <id> hubspot`); the token lives in Composio's vault under the tenant id. |
| `emailResponder` | `{ enabled }`: owner follow-up email per lead, from the owner's Gmail through Composio (`scripts/connect-composio.mts <id>`). Default off; the workflow refuses a tenant whose flag is off. |
| `assistant` | `{ enabled, tools }`: the chat assistant for the tenant's people. `tools` is the allow-list, by name from the catalog in `workflows/assistant/assistant-loop.ts` (`search_contacts`, `add_note`; both need the HubSpot consent). Empty means it answers from the prompt and memory alone. |
| `browser` | `{ enabled, contextId }`: the tenant's saved browser in Browserbase (cookies, logins). The browser-login workflow creates the context on the owner's first `/login` and writes it to the row; copy it into the file when the reply says so, or a re-seed starts a fresh browser. |

### The automations menu

Each after-call automation is a file in `packages/infrastructure/workflows/` exporting an
`Automation` descriptor (`workflows/automations/automation.ts`: the bus event that starts it, Express or not,
timeout, grants, definition). A tenant file lists the ones it runs:

| Descriptor | On | What it does |
|---|---|---|
| `crmLead` | `lead.recorded` | HubSpot contact upserted by phone, note with the lead, follow-up task due the next business morning in the tenant's timezone, assigned to the account's first owner |
| `crmCall` | `call.ended` | Transcript note on the HubSpot contact, if the caller is already a contact. The transcript is read from the call row, not the event |
| `leadEmail` | `lead.recorded` | Email to the owner from the owner's own Gmail through Composio, carrying the CRM contact, its last note, and caller memory when they exist |
| `ownerAlert` | `owner.notify` | The receptionist's urgent alert, delivered to the row's owner over the Telegram reply path |

`packages/infrastructure/stacks/tenant-stack.ts` turns the list into one stack per tenant
(`wnk-tenant-<id>-dev`): for each descriptor a state machine named for the tenant, a rule matching
only events carrying that tenant's id, the grants it declares, and an alarm. Deploying one touches
no other tenant. The definitions test synthesizes every machine and asserts the rule filter.

A variation for one tenant is, in order of preference, a parameter on the definition, a
recomposition, or a copied definition in that tenant's file. Never a Choice state inside a
definition another tenant runs on. The `new-tenant` skill has the sizes with examples.

**CRM (HubSpot through Composio).** Opt-in via `crm: { type: "hubspot", via: "composio" }`. The owner
approves Composio's HubSpot app once; no HubSpot token exists anywhere in the platform. Every CRM
call names the tenant (Composio `userId` = our tenant id), so the credential is chosen per call. CRM
upgrades the other capabilities rather than standing alone: caller recognition in accept, the history
section of the lead email, and the assistant's tools. A second CRM is another set of HTTP-task states
in the definitions, selected by the row's `crm.type`. Prove a tenant's connection with
`npx tsx scripts/test-crm-workflows.mts <id> <phone>`.

## 3. Operating: traces, alarms, dead letters

Every Lambda runs with X-Ray active, and the trace is carried by hand across the seams X-Ray
doesn't cross on its own: the SQS message to the session Lambda (`AWSTraceHeader`) and the
EventBridge event (`TraceHeader`). Every state machine runs with tracing on, so a trace started at
the webhook continues through accept, the session Lambda, the bus event, and the workflow it starts.
Every log line carries `traceId`, `tenantId`, and `callId` where known, so one Logs Insights query
across the log groups reconstructs a call:

```
fields @timestamp, @log, msg, tenantId, callId
| filter callId = "rtc_..." or traceId = "..."
| sort @timestamp
```

Every stack's alarms page one SNS topic (`<prefix>-alarms`): dead-letter queues holding anything,
workflow executions that failed, and Lambda errors. Who it pages is operator data, subscribed once
out of band (see Setup). Failures after retries land in a dead-letter queue (session jobs, workflow
starts), and each queue has an alarm. A workflow execution that fails alarms on the state machine's
failed-executions metric.

Delivery is at-least-once everywhere (EventBridge, Lambda async retries, SDK retries), so every
event consumer with an external side effect checks a once-marker on the call row before acting
and sets it after success (`checkDone` / `markDone` states from `workflows/asl.ts`, keys like
`done:crm:lead:<leadId>`, `done:crm:call`, `done:email:lead:<leadId>`). That narrows a duplicate to
a crash between the send and the mark; it is not exactly-once. Anything that costs money or reaches
a customer irreversibly should get a pending → completed ledger with reconciliation instead.

Standard workflows (Telegram, owner alert, CRM lead, the canaries) keep their history for replay;
workflows that handle transcripts or CRM notes (accept, call-ended, lead email, CRM call) are Express
with execution data not logged, so only the state path and the error are kept. Events carry ids and
outcomes; the transcript stays on the call row and is fetched by id where needed.

**The session Lambda.** `aws logs tail /aws/lambda/wnkinc-voice-dev-session --follow`. Deploying
new session code is `npm run deploy`. Because in-flight calls live inside a Lambda invocation, a
deploy never interrupts them: running invocations finish on the old code, new calls get the new code.

**A tenant misbehaves.** `npx tsx scripts/check-tenant.ts <id>` prints the provisioning checklist:
config drift between file and row, secrets, services, owner alert channel, Gmail connection.

**Cost and scale.**

- Everything (HTTP API, two Lambdas, Step Functions, DynamoDB, SQS, EventBridge) is on-demand and ~$0 idle;
  per call you pay OpenAI Realtime usage plus Lambda duration for the call's length
  (a 10-minute call at 512 MB is well under a cent).
- Each call is its own invocation with its own 512 MB — the session Lambda holds a socket and
  does JSON, no audio. `sessionMaxConcurrency` (default 20) caps simultaneous calls; the account
  concurrency limit is the hard ceiling.
- There is no mid-call failover: if an invocation dies the call drops and the caller calls back.
  Undelivered jobs wait in SQS up to an hour.
- Calls table rows expire after 90 days (TTL). All tables use `RemovalPolicy.DESTROY` while this
  is a learning stack; flip to `RETAIN` before real data.

## 4. Setup

### Prerequisites

- Node 22+, AWS CLI configured (CDK bootstrap runs once per account/region: `npx cdk bootstrap`)
- Two AWS profiles. `wnk-ops` is the operator: an IAM user with the `WnkOperate` policy, which can
  write tenant rows, platform secrets, and Connections, start and read executions, read logs and
  metrics, and run `cdk diff`, but cannot touch CloudFormation or IAM. It is the laptop's default
  profile and the one this repo pins for its coding agent (`.claude/settings.json`). Admin is a
  named profile (`wnk-admin`) used by hand for deploys and account changes. The policy is
  `ops/wnk-operate-policy.json`; a script that hits an AccessDenied names the exact action, and the
  fix is a line there, applied by a person (`ops/README.md`), never a switch to admin.
- An OpenAI project with Realtime access (note the `proj_…` id under *Settings → Project → General*)
- A Twilio account with a phone number

### Deploy

```bash
npm install
npm test
npx cdk bootstrap                           # once per account/region
npm run deploy
```

IaC is AWS CDK (TypeScript, `packages/infrastructure/`); Lambdas are bundled by `NodejsFunction`
(esbuild) at deploy time. Stacks: memory, voice, runtime, then one per tenant
(`bin/app.ts` builds one platform object and feeds it to the runtime stack and every tenant stack).

The alarm topic is created by the stack; **who it pages is not** — subscribe once, out of band,
and no later deploy can remove it:

```bash
aws sns subscribe --topic-arn <alarmTopicArn output> --protocol email \
  --notification-endpoint you@yourdomain.com     # then confirm the email
```

Outputs (printed by `npm run deploy`, or `aws cloudformation describe-stacks --stack-name wnk-voice-dev`): `webhookUrl`, `openaiSecretArn`, `tenantsTableName`, `callsTableName`, `eventBusName`, `sessionQueueUrl`, `sessionFunctionName`.

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

Copy `tenants/example.json` to `tenants/<tenantId>.json` (one file per tenant, keyed by its *called* number; only the example is tracked) and:

```bash
TENANTS_TABLE=<tenantsTableName output> PEOPLE_TABLE=<peopleTableName output> COMPOSIO_SECRET_ARN=<composioSecretArn output> AWS_REGION=us-west-2 npm run seed -- tenants/<tenantId>.json
```

Then create `tenants/<tenantId>.ts` (copy `tenants/wnk.ts`), add it to `tenants/index.ts`, and
`npx cdk deploy wnk-tenant-<tenantId>-dev`. The full procedure, including consents and people, is
the `new-tenant` skill.

Call the number. With Twilio Elastic SIP Trunking the `To` header carries the OpenAI
project id and the dialed number arrives in `Diversion`; the accept workflow's SIP parsing
(`SIP_CALLED_HEADERS` in `packages/infrastructure/workflows/receptionist/accept.ts`) handles that. If another
carrier puts it elsewhere, add the header name there.

### 5. Telegram bot

1. BotFather → `/newbot`; copy the token.
2. Put it in the Telegram secret (keep the generated `WEBHOOK_PATH`):
   `aws secretsmanager put-secret-value --secret-id <telegramSecretArn> --secret-string "$(aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text | jq -c --arg t '<token>' '.TELEGRAM_BOT_TOKEN = $t')"`
3. `npx tsx scripts/telegram-webhook.mts set`, then `... info` to confirm no `last_error_message`.

Per person: add them to the tenant file's `people` with their Telegram user id (message the bot once;
the id is `message.from.id` in the workflow's execution input), then re-seed. Removing them from the
file and re-seeding removes their access.

### 6. Twilio SMS

The tenant's number must be SMS-capable and, for US traffic, registered for A2P 10DLC (Twilio
console; unregistered business SMS is filtered by the carriers). Put the account SID and auth token
in the Twilio secret (keep the generated `WEBHOOK_PATH`), and write them to the Connection too,
because CloudFormation resolves a secret reference only when the resource itself changes:

```bash
aws secretsmanager put-secret-value --secret-id <twilioSecretArn> --secret-string "$(aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text | jq -c '.TWILIO_ACCOUNT_SID = "AC..." | .TWILIO_AUTH_TOKEN = "..."')"
aws events update-connection --name <TwilioConnection name> --authorization-type BASIC \
  --auth-parameters '{"BasicAuthParameters":{"Username":"AC...","Password":"..."}}'
```

Then, per tenant, point the number's messaging webhook at the platform:
`npx tsx scripts/twilio-webhook.mts set <tenantId>` (`info` shows what the number has). Per person:
add their mobile as `phone` in the tenant file's `people` and re-seed.

### 7. Browserbase

Create a Browserbase project. Its id goes in `cdk.json` context as `browserbaseProjectId` (not a
secret; a literal in the definition). The key goes in the secret and, because CloudFormation resolves
a secret reference only when the resource itself changes, into the EventBridge Connection directly
(the same applies to every Connection here after a rotation):

```bash
aws secretsmanager put-secret-value --secret-id <browserbaseSecretArn> --secret-string '{"BROWSERBASE_API_KEY":"bb_live_..."}'
aws events update-connection --name <BrowserbaseConnection name> \
  --auth-parameters '{"ApiKeyAuthParameters":{"ApiKeyName":"X-BB-API-Key","ApiKeyValue":"bb_live_..."}}'
```

The first `/login` for a tenant creates its context and the reply names the id; paste it into the
tenant file as `browser.contextId` so a re-seed keeps it.

## The Temporal worker

The orchestration engine the platform is moving to. `packages/worker` is a Temporal Worker:
workflows (deterministic, replayed from history) and activities (the side effects, each taking
its tenant id as an argument). It runs as a container Lambda that Temporal Cloud invokes when
the task queue has work (Serverless Workers, public preview) and exits when the invocation
deadline nears: idle costs nothing, no fleet. The stack (`stacks/worker-stack.ts`) declares the
function, the invocation role only Temporal's accounts may assume (gated by a generated external
id), the platform secret holding the namespace connection, and the SMS front door.

**The assistant on Temporal.** The same flows as the Step Functions routes, side by side with
them until the cutover. One loop (`workflows/loop.ts`: memory, the model, the gated tools, the
round cap) under three workflows: `smsTurn` (Twilio posts to `/temporal/sms/<WEBHOOK_PATH>`, one
workflow per text keyed by the MessageSid), `telegramTurn` (Telegram posts to
`/temporal/telegram/<WEBHOOK_PATH>`, one per update keyed by the update id, the reply through the
Bot API as an activity), and `assistantHealth` (a Temporal Schedule every morning; a silent
tenant fails the workflow, which is the alarm). The owner's `/login` starts `browserLogin`, whose
window is a durable timer. The starters are the same image with different handlers, and a
redelivered webhook starts nothing twice. Facebook drafts and the POST approval carry over
unchanged (`packages/worker/src/sms/facebook.ts`, the ledger rules as pure functions;
`test/sms-turn.test.ts` runs the workflow through a real Worker with recorded fakes and holds the
split: POST publishes once, only on the shown revision, never through the model). Point traffic
with `npx tsx scripts/twilio-webhook.mts set <tenantId> temporal` and
`npx tsx scripts/telegram-webhook.mts set temporal`.

**Releasing.** Every change that should reach the worker, code or configuration, is a new build
id in `packages/worker/src/version.ts`: a published Lambda version is immutable, so nothing
changes under a running workflow, and rollback is one Temporal command. After
`npm run deploy -- wnk-worker-dev`, `npm run release` publishes the Lambda version, registers the
build id against it, confirms Temporal's validation invocation bound the task queue, and sets it
current. `npm run temporal -- workflow list` runs the CLI against the namespace with the worker's
key (the browser login expires; this does not).

**When it breaks.** Two alarms from the SDK's own log lines: a failed workflow (an activity
exhausted its retries, or the workflow threw; what a failed execution was on Step Functions) and
five failed activities in an hour. Serverless Workers are a preview: the same image runs as a
Fargate service at zero tasks (`packages/worker/src/service.ts`, announcing the same build id),
and the stack output `fallbackService` is the one command that brings it up; the queue drains
with no release. Set it back to zero when the Lambda path is healthy again.

## Where things live

Each package has its own README: what rented service it sits on, what its code is allowed to
do, and how to verify it. Start there when changing one. The `new-tenant`, `new-tool`, and
`new-agent` skills under `.claude/skills/` are the procedures for the recurring changes.

| Path | What |
|---|---|
| `packages/receptionist/src/webhook.ts` | Lambda (~40 lines, stdlib): verifies the OpenAI webhook signature and starts the accept workflow. The one piece of the call path that must be code |
| `packages/receptionist/src/session.ts` | Lambda: SQS-triggered, one call per invocation, holds the WebSocket for the call's duration. Owns the socket and nothing else: memory and usage are the call-ended workflow's |
| `packages/receptionist/src/call.ts` | One call: `RealtimeSession` + `OpenAIRealtimeSIP` (the OpenAI Agents SDK runs the tool loop); transcripts, time limit, hangup |
| `packages/receptionist/src/agent.ts` | The receptionist: system prompt, the three tools (`record_lead`, `notify_owner`, `end_call`), session config, `accept` payload. To add a tool: a zod args schema, a handler, a `tool({...})` entry, then its name in a tenant's `tools`. Tools that need durability publish an event and return; a workflow consumes it |
| `packages/infrastructure/workflows/` | One file per Step Functions definition, grouped by system: `receptionist/` (accept, call-ended), `assistant/` (the agent loop and tool catalog, telegram, sms, browser-login), `automations/` (the descriptor and the four stock automations tenants pick from), `canaries/` (composio-health, assistant-health): a function from resource names to the JSONata definition object, no CDK imports, its expressions exported for unit tests. `asl.ts` is the grammar they share (`q`, `httpTask`, `composio` whose every call names the tenant, the once-marker pair). `automation.ts` is the descriptor the four automations export |
| `packages/media-link/` | The one Lambda on the assistant path: a texted photo's Twilio ids -> the signed link Twilio redirects to (about four hours, fetchable by anyone). Code because Step Functions fails an HTTP task on a 307 and keeps the Location header from the workflow. Takes ids, never a URL; refuses a photo not texted to the tenant's number it is given. Moves no bytes, stores nothing |
| `packages/infrastructure/workflows/assistant/facebook-post.ts` | Facebook posts over SMS, and the pattern for every action that reaches a customer irreversibly: the model drafts into the Actions ledger (`ActionSchema` in `@wnk/shared`), the workflow texts the draft word for word from the row, the person's reply POST (matched before the model runs, on the revision they were shown) publishes. The model has no publish tool; the definitions test holds that |
| `packages/telegram-mcp/` | A tenant's own Telegram account (a user login, not the assistant's bot) as a remote MCP server for their ChatGPT or Claude: the pinned chigwell/telegram-mcp engine in a container Lambda behind a secret URL. `server.py` only loads the tenant's secrets and removes the tools Lambda can't serve. Onboarding in its README |
| `tenants/<id>.ts`, `tenants/index.ts` | What that tenant runs: its automations on the bus, and `telegramMcp` for the connector. The registry is one line per tenant. Tracked, unlike the rows |
| `packages/infrastructure/stacks/tenant-stack.ts` | One stack per tenant with automations, from its file |
| `packages/infrastructure/stacks/telegram-mcp-stack.ts` | One stack per tenant with `telegramMcp`: the connector Lambda, its Function URL, a role that reads only that tenant's secret. Takes no platform handles |
| `packages/infrastructure/stacks/runtime-stack.ts` | The platform workflows every tenant shares: Telegram and SMS (each running the assistant loop), browser login, call-ended, the two canaries, and the Telegram reply path |
| `packages/infrastructure/stacks/voice-stack.ts`, `memory-stack.ts` | The call path (API, two Lambdas, accept workflow, tables, bus, queues, the OpenAI and Composio Connections, alarm topic); caller memory |
| `packages/infrastructure/bin/app.ts`, `infra_utils/` | Stack wiring; alarm and state-machine presets |
| `packages/shared/src/` | `types.ts` (`TenantConfig` zod schema, records, events), `store.ts` (DynamoDB behind one `Store` interface plus an in-memory version; no leads table, the CRM holds the lead and the call row is the audit), `events.ts` (EventBridge publisher), `config.ts` (env, secrets, OpenAI client, logger), `composio.ts` (Composio SDK, scripts only) |
| `scripts/` | `seed-tenant.ts` (row upsert), `check-tenant.ts` (pre-flight), `connect-composio.mts` (consent links), `telegram-webhook.mts` and `twilio-webhook.mts` (point each channel at the platform), and the `test-*.mts` provers |
| `tenants/example.json` | Example tenant config |
| `ops/` | Operator data applied by hand from the admin profile: the `WnkOperate` policy the coding agent runs under |
| `packages/*/test/` | vitest suites. The infrastructure one synthesizes every state machine, checks the platform invariants, validates each with the service, and compares each to its file under `test/snapshots/`: a change to a shared definition shows as a diff on every tenant machine it alters. `npm run deploy` runs the tests first; `npm run test:update` records intended changes |

## Roadmap

- Scheduling, callbacks, and approvals as Step Functions workflows on bus events (Wait states and task tokens; no separate orchestrator)
- `transfer_call` tool using `POST /calls/{id}/refer`
- Business-hours awareness / after-hours script
- Per-tenant API keys / OpenAI projects if needed for billing isolation
- Admin API for tenant CRUD (today: `npm run seed`)
