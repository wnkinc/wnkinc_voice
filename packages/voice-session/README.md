# voice-session

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
| API Gateway HTTP + Lambda | Receives the webhook; the Lambda only verifies the signature. | `infrastructure/stacks/voice-stack.ts` |
| Step Functions accept workflow (Express, no execution data) | Called number → tenant, claim, accept, caller recognition, job to SQS. All managed tasks; SIP parsing is a unit-tested JSONata expression. | `infrastructure/workflows/accept.ts` |
| SQS (batch size 1, partial batch failure) | Hands one call to one session invocation; a failed attach dead-letters at once (a retry after the 16-minute visibility timeout would find a dead call). | https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html |
| DynamoDB Tenants / Calls | Tenant row keyed by called number; call row is the audit (transcript, tool calls, once-markers). | |
| EventBridge bus `wnkinc.voice` | `lead.recorded`, `owner.notify`, `call.ended` fan out to the CRM sync here and the runtime stack's workflows, each with retries and a DLQ. | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html |
| Composio (HubSpot) | Caller recognition, from the accept workflow, under the tenant id. | |
| AgentCore Memory | Caller facts recalled by the accept workflow; the transcript is written by the call-ended workflow (runtime stack), not here. | |

## What the code is allowed to do, per file

- `webhook.ts` — the one job only code can do on this path: verify the webhook HMAC over the raw body, then start the accept workflow. About 40 lines, stdlib crypto, no SDK bundle. Everything it used to do (tenant, claim, accept, recognition, enqueue) is the accept workflow in the voice stack.
- `session.ts` / `call.ts` — hold the WebSocket for one call, log transcripts and tool calls to the call row, enforce the time limit, hang up cleanly, publish `call.ended` (ids and outcome). Nothing else: memory and usage are the call-ended workflow's. A Lambda holds it because nothing managed holds a WebSocket for fifteen minutes and runs tools.
- `agent.ts` — tenant row → session config (prompt, voice, model, tools) sent on attach, and the three tools. Each tool is one publish. The tenant comes from the call context; the model never names it.
- Event consumers: none here. Every consumer of `lead.recorded`, `owner.notify`, and `call.ended` is a Step Functions workflow in the runtime stack (CRM sync, lead email, owner alert). The `call.ended` event carries ids and the outcome only; the transcript stays on the call row.

Tenant id enters exactly once, from the signed webhook's called number, and is carried on every record and event from there.

## How to verify

```bash
npm test            # agent, session, webhook (signature) suites; infrastructure/test unit-tests the JSONata expressions and validates every synthesized state machine with the Step Functions API
```

Live, after a deploy: call the tenant's number and follow the session log.

```bash
aws logs tail /aws/lambda/wnkinc-voice-dev-session --follow
```

- The accept workflow's log group shows the state path per call (no payloads); an unknown called number fails the execution and alarms.
- The call row in the Calls table is the audit: `transcript`, `toolCalls` (each tool with its arguments), and a `done:<key>` attribute per consumer that succeeded.
- `npx tsx scripts/check-tenant.ts <tenantId>` reports config drift, secrets, and the owner's connected accounts.
- `npx tsx scripts/test-crm-workflows.mts <tenantId> <phone>` proves the CRM workflows with real events; `scripts/test-lead-email.mts` does the same for the lead email.
