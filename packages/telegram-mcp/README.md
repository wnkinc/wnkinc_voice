# telegram-mcp

A tenant's own Telegram account (a user login, not the assistant's bot) served
as a remote MCP server, so the tenant's ChatGPT or Claude can read and act in
their Telegram. One container Lambda per tenant, deployed as
`wnk-telegram-mcp-<id>-dev` when `tenants/<id>.ts` sets `telegramMcp: true`.
It needs nothing else from the platform: no number, no row, no bus.

Not to be confused with `workflows/assistant/telegram.ts`, the bot a tenant's
people message to reach the assistant.

## What it sits on

| Rented thing | What it does for us | Reference |
|---|---|---|
| chigwell/telegram-mcp | The whole MCP server: ~130 Telegram tools (111 exposed here) over Telethon (MTProto). Unmodified, pinned by commit + sha256 in the `Dockerfile`, deps from its own `uv.lock`. | https://github.com/chigwell/telegram-mcp |
| Lambda (container image, arm64) + Function URL | Hosts it; Lambda Web Adapter forwards URL requests to the engine's HTTP server. | https://github.com/awslabs/aws-lambda-web-adapter |
| SSM Parameter Store (SecureString) | The tenant's `api-id`, `api-hash`, `session-string`, `url-token` under `/wnkinc-voice-dev/<id>/telegram-mcp/`. | |
| The client's connector settings (ChatGPT developer mode or Claude custom connector) | Which tools need a confirmation before running. The server exposes every tool that works here. | |

## What the code is allowed to do

`server.py` only: load the tenant's four parameters (the path comes from the
stack; no path, no server), remove the tools Lambda can't serve (listed in the
file with why), serve MCP at `/mcp/<url-token>` with plain JSON replies, and
keep request logging off so the token never reaches CloudWatch. Every other
path is a 404.

The tenant is fixed at deploy: the stack names the secret path and the role
reads only that path. No request names a tenant, and the engine's `account`
argument can only reach the one session this function holds. The URL token
authenticates the caller; it selects nothing. Anyone holding the full URL holds
the tenant's Telegram account, so the token is a password and is rotated like
one.

Limits that follow from Lambda: one instance at a time (Telegram revokes a
session seen from two IPs at once), so concurrent calls from the client can get
a 429; a cold start of about 6s on the first call after idle.

## Onboard a tenant

1. `tenants/<id>.ts` with `telegramMcp: true` (see `tenants/meg.ts`), listed in `tenants/index.ts`.
2. The tenant creates an API ID and hash at https://my.telegram.org (their own, so a flag on their account never lands on ours).
3. Session string, with the tenant on a call scanning the QR code (Telegram → Settings → Devices → Link Desktop Device):
   `docker build --platform linux/arm64 -t telegram-mcp packages/telegram-mcp`, then
   `docker run -it --rm -e TELEGRAM_API_ID=<id> -e TELEGRAM_API_HASH=<hash> telegram-mcp python session_string_generator.py --qr`
4. Secrets, entered at hidden prompts so nothing lands in shell history or chat:
   ```
   T=<tenantId>; for p in api-id api-hash session-string; do read -s "v?$p: "; echo; aws ssm put-parameter --region us-west-2 --type SecureString --name /wnkinc-voice-dev/$T/telegram-mcp/$p --value "$v"; done
   aws ssm put-parameter --region us-west-2 --type SecureString --name /wnkinc-voice-dev/$T/telegram-mcp/url-token --value "$(openssl rand -hex 32)"
   ```
5. `npx cdk deploy wnk-telegram-mcp-<id>-dev`. The connector URL is the `baseUrl` output + `mcp/` + the `url-token` value.
6. In the client: a new connector with that URL and no authentication.

## Verify

```
URL=<baseUrl>mcp/<url-token>
curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_me","arguments":{}}}' $URL
```
A wrong token is a 404. Logs: `/aws/lambda/wnkinc-voice-dev-<id>-telegram-mcp`; a missing parameter or a revoked session fails the init there.

## Rotate, offboard

- **Rotate the URL**: put a new `url-token` with `--overwrite`, then force a fresh instance so it reads the new value (a deploy with no changes does not): `aws lambda update-function-configuration --region us-west-2 --function-name wnkinc-voice-dev-<id>-telegram-mcp --description "token rotated $(date +%F)"`. Give the tenant the new URL.
- **Offboard**: the tenant ends the session in Telegram → Settings → Devices (this alone cuts access), then remove `telegramMcp` from their file, `npx cdk destroy wnk-telegram-mcp-<id>-dev`, and delete the four parameters.
- **Upgrade the engine**: new `TG_COMMIT` and its sha256 in the `Dockerfile`. If a removed tool was renamed, the server refuses to start rather than exposing it; update the list in `server.py`.
