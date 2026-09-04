# email-responder

One Lambda on the `lead.recorded` rule. For each lead the receptionist records,
it emails the tenant's owner a summary with CRM history and a suggested reply,
sent from the owner's own Gmail.

## What it sits on

| Rented thing | What it does for us |
|---|---|
| EventBridge rule (`infrastructure/lib/runtime-stack.ts`) | Delivers `lead.recorded`; two retries, one-hour max age, then a dead-letter queue with an alarm. A lost email is an alarm, not a log line. |
| Composio | Holds the owner's Gmail and HubSpot tokens under our tenant id. The function names the tenant on every call and holds no credential. |
| AgentCore Memory | Facts about the caller extracted from earlier calls. |
| OpenAI chat completions | Drafts subject and body as JSON. Falls back to a plain template if the call fails. |
| Secrets Manager | The OpenAI and Composio API keys. |
| DynamoDB Calls / Tenants / Usage | Tenant row for the enabled flag; call row for the once-marker; usage rows for metering. |

## What the code is allowed to do

Resolve the tenant from the event (`requireTenant`: missing or unknown fails closed), check
`products.emailResponder.enabled`, check the once-marker `email:lead:<leadId>` before spending
anything, then enrich → draft → send → mark done → meter. Enrichment and drafting degrade
quietly; tenant lookup and the send fail loudly so retries and the alarm do their job.

Nothing in this file is something only code can do. It is a fixed sequence of tool calls under
the tenant's Composio credentials, which is what the My Assistant harness already does with a
free prompt. Folding this into the harness with a fixed prompt is the most likely next
simplification.

Trigger to watch: the once-marker is hardening, not exactly-once. If this ever emails the
customer rather than the owner, it needs a pending → completed ledger with reconciliation first.

## How to verify

There are no unit tests for this package yet. Verification is live:

1. Tenant row has `products.emailResponder.enabled: true` and the owner's Gmail is connected
   (`npx tsx scripts/connect-composio.mts <tenantId> gmail`; `scripts/check-tenant.ts` confirms).
2. Call the number and give the receptionist a lead.
3. In the responder's log group look for `lead received`, `crm context fetched`, `email sent`.
4. The call row now carries `done:email:lead:<leadId>` and the Usage table has an `emails_sent` row.
5. The dead-letter queue alarm on the runtime stack stays quiet.
