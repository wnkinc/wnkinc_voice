# receptionist

The phone receptionist: two Lambdas and the accept workflow that take a call from
ring to hangup and publish what happened. Everything that carries audio, holds credentials, or
retries is rented; the code here resolves the tenant, threads it through, and
fails closed.

## What it sits on

| Rented thing | What it does for us | Reference |
|---|---|---|
| Twilio Elastic SIP Trunking | Owns the number; forwards the call to OpenAI. Audio never enters AWS. | https://www.twilio.com/docs/sip-trunking |
| OpenAI Realtime SIP | Answers the SIP call, fires the signed `realtime.call.incoming` webhook, exposes accept/reject and the call WebSocket. | https://platform.openai.com/docs/guides/realtime-sip · https://platform.openai.com/docs/guides/webhooks |
| OpenAI Agents SDK (`RealtimeSession` + `OpenAIRealtimeSIP`) | Runs the tool loop: validates arguments against zod, calls our handler, returns the result to the model. | https://github.com/openai/openai-agents-js/tree/main/examples/realtime-twilio-sip (the shape `call.ts` copies) |
| API Gateway HTTP + Lambda | Receives the webhook; the Lambda only verifies the signature. | `infrastructure/stacks/receptionist-stack.ts` |
| Step Functions accept workflow (Express, no execution data) | Called number → tenant, claim, accept, caller recognition, job to SQS. All managed tasks; SIP parsing is a unit-tested JSONata expression. | `infrastructure/workflows/receptionist/accept.ts` |
| SQS (batch size 1, partial batch failure) | Hands one call to one session invocation; a failed attach dead-letters at once (a retry after the 16-minute visibility timeout would find a dead call). | https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html |
| DynamoDB Tenants / Calls | Tenant row keyed by called number; call row is the audit (transcript, tool calls, once-markers). | |
| EventBridge bus `wnkinc.voice` | `lead.recorded`, `owner.notify`, `call.ended` fan out to the workflows on the worker (a rule per tenant stack, one platform rule), each with retries and a DLQ. | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html |
| Composio (HubSpot) | Caller recognition, from accept, under the tenant id and a deadline. | |
| AgentCore Memory | Caller facts recalled by accept; the transcript is written by the `callEnded` workflow on the worker, not here. | |

## What the code is allowed to do, per file

- `webhook.ts` — the one job only code can do on this path: verify the webhook HMAC over the raw body, then start the accept workflow. About 40 lines, stdlib crypto, no SDK bundle. Everything it used to do (tenant, claim, accept, recognition, enqueue) is the accept workflow in the voice stack.
- `session.ts` / `call.ts` — hold the WebSocket for one call, log transcripts and tool calls to the call row, enforce the time limit, hang up cleanly, publish `call.ended` (ids and outcome). Nothing else: memory and usage are the call-ended workflow's. A Lambda holds it because nothing managed holds a WebSocket for fifteen minutes and runs tools.
- `prompt.ts` — tenant row (`business`, `receptionist.instructions`, `receptionist.greeting`) → the receptionist's system prompt and greeting.
- `agent.ts` — tenant row (`receptionist.session`, passed under OpenAI's own keys) plus the platform defaults below → session config sent on attach, and the three tools. Each tool is one publish. The tenant comes from the call context; the model never names it.
- Event consumers: none here. Every consumer of `lead.recorded`, `owner.notify`, and `call.ended` is a workflow on the worker (CRM sync, lead email, owner alert, call-ended). The `call.ended` event carries ids and the outcome only; the transcript stays on the call row.

Tenant id enters exactly once, from the signed webhook's called number, and is carried on every record and event from there.

## Levers: what OpenAI Realtime offers, and where each one stands

Every knob the receptionist could turn, in one place, so "not using" is stated
rather than missing. Three states only: a **platform default** (in `agent.ts` or
`prompt.ts`, same for every tenant, with its value), a **tenant field** (in the
row, with its path under `receptionist`), or **not built** (with the path it will
get). A tenant file lists only what differs from the defaults; this table is
where the defaults and the unbuilt levers are written down. Hand-maintained.

| Lever | OpenAI parameter or SDK feature | State | Where |
|---|---|---|---|
| Model | `session.model` | tenant field, default `gpt-realtime-2.1` | `receptionist.session.model` |
| Voice | `audio.output.voice` | tenant field, default `marin` | `receptionist.session.audio.output.voice` |
| Speaking speed | `audio.output.speed` | not built | `receptionist.session.audio.output.speed` |
| Output modality | `output_modalities` | platform default: `['audio']` | `agent.ts` |
| Turn detection | `audio.input.turn_detection` | platform default: `semantic_vad`, interrupt on | `agent.ts` |
| Eagerness | `turn_detection.eagerness` | not built | `receptionist.session.audio.input.turn_detection.eagerness` |
| Noise reduction | `audio.input.noise_reduction` | platform default: `far_field` | `agent.ts` |
| Transcription model | `audio.input.transcription.model` | platform default: `gpt-4o-mini-transcribe` | `agent.ts` |
| Transcription language and vocabulary | `transcription.language`, `transcription.prompt` | not built (misheard names on the first calls: the trigger) | `receptionist.session.audio.input.transcription` |
| Temperature, max output tokens | `session.temperature`, `max_output_tokens` | platform default: OpenAI's | `agent.ts` |
| Instructions | `session.instructions` | composed by `prompt.ts` from `business` and the platform sections (job, scope, time, tools, style, caller id) | `receptionist.instructions.agentName`, `receptionist.instructions.extra` |
| Unclear audio, read-back, variety | prompt sections OpenAI's realtime prompting guide recommends | partly built: read-back of phone numbers is in; unclear-audio handling and phrase variety are not (platform, no field) | `prompt.ts` |
| Greeting | `response.create` with instructions, on connect | tenant field, default templated from the business name | `receptionist.greeting` |
| Hold instruction | `accept` payload instructions | platform default: "do not speak until instructed" | `workflows/receptionist/accept.ts` |
| Tools | `session.tools` (function tools from zod schemas) | tenant picks names from the platform catalog | `receptionist.session.tools` |
| Tool choice, parallel tool calls | `tool_choice` | platform default: OpenAI's | `agent.ts` |
| Output guardrails | Agents SDK `outputGuardrails` (checked on the transcript as it streams; trips cut the response) | not built; the "never invent prices or promises" rule is prompt-only today | `receptionist.guardrails` |
| Handoffs | Agents SDK `RealtimeAgent` handoffs | not built; trigger: two caller kinds with different jobs | `receptionist.handoffs` |
| Transfer to a human | Calls API refer (SIP REFER) | not built | `receptionist.transfer` |
| End-of-call summary | out-of-band `response.create` (`conversation: none`) | not built; the CRM note carries the raw transcript today | `receptionist.summary` |
| Interruption handling | `conversation.item.truncate` | platform: the Agents SDK does it | |
| Time limit | none (our Lambda deadline) | tenant field, default 600, max 840 | `receptionist.maxCallSeconds` |
| Tracing | `session.tracing` | platform: X-Ray on our side; OpenAI-side tracing off | |
| Reusable prompts, MCP session tools, image input | `prompt`, `tools[type=mcp]`, image content | not applicable to a phone receptionist | |

## How to verify

```bash
npm test            # agent, session, webhook (signature) suites; infrastructure/test unit-tests the JSONata expressions and validates every synthesized state machine with the Step Functions API
```

Live, after a deploy: call the tenant's number and follow the session log.

```bash
aws logs tail /aws/lambda/wnk-dev-session --follow
```

- The accept workflow's log group shows the state path per call (no payloads); an unknown called number fails the execution and alarms.
- The call row in the Calls table is the audit: `transcript`, `toolCalls` (each tool with its arguments), and a `done:<key>` attribute per consumer that succeeded.
- `npx tsx scripts/check-tenant.ts <tenantId>` reports config drift, secrets, and the owner's connected accounts.
- `npx tsx scripts/test-crm-workflows.mts <tenantId> <phone>` proves the CRM workflows with real events; `scripts/test-lead-email.mts` does the same for the lead email.
