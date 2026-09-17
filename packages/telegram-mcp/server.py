"""One tenant's Telegram account as a remote MCP server, on Lambda.

The engine (chigwell/telegram-mcp) runs unmodified; this file only loads the
tenant's secrets, removes the tools Lambda can't serve, and puts the server
behind a secret URL path. The token is the only gate: anyone holding the full
URL holds this Telegram account.
"""

import os

SSM_PARAMS = {
    "api-id": "TELEGRAM_API_ID",
    "api-hash": "TELEGRAM_API_HASH",
    "session-string": "TELEGRAM_SESSION_STRING",
    "url-token": "URL_TOKEN",
}

# Tools that can't work here: nothing the client holds reaches this disk, and
# anything written to it is gone at the next cold start.
UNSUPPORTED_ON_LAMBDA = [
    # local file paths
    "send_file",
    "send_album",
    "send_voice",
    "send_sticker",
    "upload_file",
    "download_media",
    "set_profile_photo",
    "edit_chat_photo",
    # event waits: hold the single instance for up to 50s, blocking every other call
    "wait_for_new_message",
    "wait_for_settled_message",
    # JSONL feed for Claude Code callbacks
    "enable_incoming_feed",
    "disable_incoming_feed",
    "incoming_feed_status",
    # aliases persist to local disk
    "set_contact_alias",
    "list_contact_aliases",
    "delete_contact_alias",
    # TELEGRAM_TRANSCRIBE=off
    "transcribe_voice",
]


def load_secrets() -> None:
    import boto3

    # The stack sets the tenant's path; without it there is no tenant, so no server.
    prefix = os.environ.get("SSM_PREFIX")
    if not prefix:
        raise SystemExit("SSM_PREFIX is not set")
    names = [f"{prefix}/{key}" for key in SSM_PARAMS]
    resp = boto3.client("ssm").get_parameters(Names=names, WithDecryption=True)
    if resp["InvalidParameters"]:
        raise SystemExit(f"Missing SSM parameters: {resp['InvalidParameters']}")
    for param in resp["Parameters"]:
        os.environ[SSM_PARAMS[param["Name"].rsplit("/", 1)[1]]] = param["Value"]


def main() -> None:
    # Local runs pass everything as env; on Lambda it comes from SSM. The engine
    # reads its env at import, so this runs before any engine import.
    if "URL_TOKEN" not in os.environ:
        load_secrets()
    if len(os.environ["URL_TOKEN"]) < 32:
        raise SystemExit("url-token must be at least 32 characters")
    os.environ.setdefault("TELEGRAM_TRANSCRIBE", "off")

    import uvicorn
    from telegram_mcp import runner
    from telegram_mcp.runtime import mcp

    for name in UNSUPPORTED_ON_LAMBDA:
        mcp._tool_manager.remove_tool(name)

    mcp.settings.streamable_http_path = f"/mcp/{os.environ['URL_TOKEN']}"
    # Plain JSON replies: no SSE stream for the buffered Function URL to hold open.
    mcp.settings.json_response = True
    # FastMCP defaults to localhost-only Host headers; the Function URL host is public.
    mcp.settings.transport_security = None

    async def serve(_transport: str) -> None:
        # access_log off: the request path is the credential.
        config = uvicorn.Config(
            mcp.streamable_http_app(),
            host="0.0.0.0",
            port=int(os.environ.get("AWS_LWA_PORT", "8080")),
            access_log=False,
            log_level="warning",
        )
        await uvicorn.Server(config).serve()

    # The engine connects Telegram, then calls runner._serve; only the server swaps.
    runner._serve = serve
    runner.main()


if __name__ == "__main__":
    main()
