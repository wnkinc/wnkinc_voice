# console

The operator's read-only view: did each automation do what it should for a tenant. One Lambda
behind a Function URL serves a single page and a small tenant-scoped API. Disposable v1.

## What it sits on

| Rented thing | What it does for us |
|---|---|
| Cognito hosted UI (auth stack) | Sign-in. The ID token's `custom:businessId` claim is the tenant; the page cannot ask for another. |
| `aws-jwt-verify` | Verifies the ID token against the pool and client id. https://github.com/awslabs/aws-jwt-verify |
| Lambda Function URL | Serves the page and the API without an API Gateway. |
| SSM Parameter Store | Carries the Cognito client id to the function (a direct env var would close a CloudFormation cycle). |
| DynamoDB Tenants / Calls / Usage | Read only. |
| AgentCore Memory | Recall what the platform remembers about a caller. |

## What the code is allowed to do

Verify the token, take the tenant from the claim, and read. Every query is keyed by that tenant
id. There is no write path.

Tabs:

- **Calls** — recent calls; click one for the transcript and the tools it called. This is the
  audit view. The `/api/calls/{id}` response is the whole call row, including each tool call's
  arguments and the `done:*` markers each consumer wrote; the page renders the transcript and
  tool names today. Rendering the arguments and markers is the obvious next step.
- **Memory** — what AgentCore Memory has extracted per caller.
- **Business** — every per-tenant lever in the row, and the exact prompt they produce.
- **Costs** — metered usage × the rate card for a month. Estimates; reconcile against invoices.

## How to verify

No unit tests. Open the `consoleUrl` stack output, sign in as a user whose `custom:businessId`
is the tenant, and confirm the Calls tab lists the most recent call with its tools. The
`consoleClientId` output and the SSM parameter `/wnk/<prefix>/console-client-id` must match.
