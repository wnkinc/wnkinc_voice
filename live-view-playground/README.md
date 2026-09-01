# Live-view playground (throwaway)

Sandbox console for AgentCore Browser sessions: watch the live DCV stream, take
control from the agent, hand it back, drive navigation over CDP, start/stop
sessions. Not wired into the workspace; delete the folder when done.

## Run

```sh
cd live-view-playground
npm install
npm run dev        # starts API (8787) + vite UI (5199)
```

Open http://localhost:5199. Uses your local AWS credentials (same chain as the
CDK deploy), region from `AWS_REGION` (default us-west-2). It auto-discovers
the deployed custom browser plus the `aws.browser.v1` default.

To watch the real agent: kick off a back-office task, and its session appears
in the sidebar within ~5s — click it to attach the live view.

## Notes

- "Take control" flips the session's automation stream to DISABLED
  (`UpdateBrowserStream`), which suspends the agent's CDP stream so your DCV
  input drives; "Hand back" re-enables it.
- Presigned live-view URLs are minted server-side (SigV4 query presign, signed
  as `https:` — signing `wss:` fails silently with DCV code 1006).
- `sessionTimeoutSeconds` is a hard TTL (max 28800 = 8h), not an idle timeout.
- The IAM needed beyond your admin creds, if this ever grows up:
  `StartBrowserSession`, `StopBrowserSession`, `GetBrowserSession`,
  `ListBrowserSessions`, `UpdateBrowserStream`,
  `ConnectBrowserAutomationStream`, `ConnectBrowserLiveViewStream`,
  control-plane `ListBrowsers`.
