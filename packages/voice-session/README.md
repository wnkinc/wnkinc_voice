# voice-session

The phone receptionist: four Lambdas that take a call from ring to hangup and
publish what happened. Everything that carries audio, holds credentials, or
retries is rented; the code here resolves the tenant, threads it through, and
fails closed.

## What it sits on

| Rented thing | What it does for us | Reference |
|---|---|---|
| Twilio Elastic SIP Trunking | Owns the number; forwards the call to OpenAI. Audio never enters AWS. | https://www.twilio.com/docs/sip-trunking |
| OpenAI Realtime SIP | Answers the SIP call, fires the signed `realtime.call.incoming` webhook, exposes accept/reject and the call WebSocket. | https://platform.openai.com/docs/guides/realtime-sip · https://platform.openai.com/docs/guides/webhooks |
| OpenAI Agents SDK (`RealtimeSession` + `OpenAIRealtimeSIP`) | Runs the tool loop: validates arguments against zod, calls our handler, returns the result to the model. | https://github.com/openai/openai-agents-js/tree/main/examples/realtime-twilio-sip (the shape `call.ts` copies) |
| API Gateway HTTP + Lambda | Receives the webhook. | `infrastructure/lib/voice-stack.ts` |
| SQS (batch size 1, partial batch failure) | Hands one call to one session invocation; a failed attach is retried, three failures dead-letter. | https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html |
| DynamoDB Tenants / Calls | Tenant row keyed by called number; call row is the audit (transcript, tool calls, once-markers). | |
| EventBridge bus `wnkinc.voice` | `lead.recorded`, `owner.notify`, `call.ended` fan out to consumers with retries and a DLQ. | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html |
| Composio (HubSpot) | Caller recognition and CRM sync under the tenant id. See `shared/README.md`. | |
| AgentCore Memory | Caller facts recalled at accept, transcript written at hangup. | |

## What the code is allowed to do, per file

- `webhook.ts` — the one job only code can do on this path: verify the webhook HMAC. Then: called number → tenant row (fail closed: no row or inactive → SIP reject), claim the call id (conditional put, so OpenAI's 72-hour retries are idempotent), look the caller up in CRM and memory (best effort, 600 ms budget), accept with the tenant's config, enqueue the session job. Must answer in seconds; the call is ringing.
- `sip.ts` — pull E.164 numbers from SIP headers. On Twilio the dialed number is in `Diversion`, not `To`.
- `session.ts` / `call.ts` — hold the WebSocket for one call, log transcripts to the call row, enforce the time limit, hang up cleanly. A Lambda holds it because nothing managed holds a WebSocket for fifteen minutes and runs tools.
- `agent.ts` — tenant row → accept payload (prompt, voice, model, tools) and the three tools. Each tool is one publish. The tenant comes from the call context; the model never names it.
- `notifier.ts`, `crm-sync.ts` — event consumers. Pure glue: read the event, check the once-marker, call SES/SNS or HubSpot-via-Composio, mark done. Nothing here needs code; these are the first candidates to replace with managed targets (EventBridge → SNS topic per tenant; Step Functions HTTP task → Composio).

Tenant id enters exactly once, from the signed webhook's called number, and is carried on every record and event from there.

## How to verify

```bash
npm test            # agent, crm-sync, notifier, session, sip, webhook suites
```

Live, after a deploy: call the tenant's number and follow the session log.

```bash
aws logs tail /aws/lambda/wnkinc-voice-dev-session --follow
```

- The webhook log line `incoming call` shows the SIP headers; `to` must resolve to the tenant's `phoneNumber`.
- The call row in the Calls table is the audit: `transcript`, `toolCalls` (each tool with its arguments), and a `done:<key>` attribute per consumer that succeeded.
- `npx tsx scripts/check-tenant.ts <tenantId>` reports config drift, secrets, and the owner's connected accounts.
- `npx tsx scripts/test-crm.mts <tenantId> <phone>` proves the CRM path without a call.
