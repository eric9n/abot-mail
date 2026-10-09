#!/usr/bin/env python3
"""Call the abot-mail MCP server through abot-gateway.

Subcommands: account, send, tools. `health` is an unauthenticated GET of
/health on mail.abot.run. Archive read commands are gone.

The Worker's own /mcp only answers abot-gateway's Service Binding, so MCP
calls go to the gateway (https://abot.run/mcp by default, override with --url
or MCP_URL). MCP_TOKEN is the gateway access token for the mailbox; the
gateway maps it to the mailbox and drops it before calling the Worker.

Token order: environment variable MCP_TOKEN, then Secure Vault credential
custom.abot-mail via dynamic_credentials.add_surrogate_to_request when that
module is installed.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "https://abot.run"
DEFAULT_HEALTH_URL = "https://mail.abot.run/health"
VAULT_MODULE = "/opt/hatch/skills/skill-creator/bin/dynamic_credentials.py"
VAULT_CREDENTIAL = "custom.abot-mail"
VAULT_ENTRY = "MCP_TOKEN"
PROTOCOL_VERSION = "2025-06-18"


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def worker_base(value):
    base = (value or "").strip().rstrip("/")
    if not base:
        fail("MCP URL is empty")
    for suffix in ("/mcp", "/health"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme not in ("https", "http") or not parsed.netloc:
        fail("MCP URL must be an http(s) origin")
    return base


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def env_token():
    if "MCP_TOKEN" not in os.environ:
        return None
    token = os.environ.get("MCP_TOKEN") or ""
    if token == "":
        fail("MCP_TOKEN is set but empty")
    return token


def apply_vault(req):
    if not os.path.isfile(VAULT_MODULE):
        fail(
            "MCP_TOKEN is not set, and Secure Vault helper is not available: "
            + VAULT_MODULE
        )
    bin_dir = os.path.dirname(VAULT_MODULE)
    if bin_dir not in sys.path:
        sys.path.insert(0, bin_dir)
    try:
        import dynamic_credentials as dc
    except Exception as err:
        fail(f"could not import dynamic_credentials: {err}")
    host = urllib.parse.urlparse(req.full_url).hostname
    if not host:
        fail("MCP URL has no host")
    try:
        dc.add_surrogate_to_request(
            req,
            VAULT_CREDENTIAL,
            entry_name=VAULT_ENTRY,
            allowed_hosts=[host],
        )
    except Exception as err:
        fail(f"Secure Vault {VAULT_CREDENTIAL}: {err}")


def apply_auth(req, token):
    if token:
        req.add_header("Authorization", "Bearer " + token)
        return
    apply_vault(req)


def parse_body(raw, content_type):
    text = raw.decode("utf-8")
    if not text.strip():
        fail("empty response body")
    media = (content_type or "").split(";", 1)[0].strip().lower()
    if media == "text/event-stream":
        messages = []
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                messages.append(json.loads(payload))
            except json.JSONDecodeError as err:
                fail(f"event stream is not JSON: {err}")
        if not messages:
            fail("event stream contained no JSON-RPC message")
        return messages[-1]
    try:
        return json.loads(text)
    except json.JSONDecodeError as err:
        fail(f"response is not JSON: {err}")


def http_json(method, url, body=None, token=None, auth=False):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("User-Agent", "abot-mail-mcp-cli")
    if data is not None:
        req.add_header("Content-Type", "application/json")
        req.add_header("MCP-Protocol-Version", PROTOCOL_VERSION)
    if auth:
        apply_auth(req, token)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            content_type = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        fail(f"HTTP {err.code}: {detail}")
    except urllib.error.URLError as err:
        fail(f"request failed: {err.reason}")
    return parse_body(raw, content_type)


def rpc(base, token, method, params=None, rpc_id=1):
    message = {"jsonrpc": "2.0", "id": rpc_id, "method": method}
    if params is not None:
        message["params"] = params
    payload = http_json("POST", base + "/mcp", message, token=token, auth=True)
    if not isinstance(payload, dict):
        fail("MCP response was not a JSON object")
    error = payload.get("error")
    if error:
        fail(json.dumps(error, ensure_ascii=False))
    if "result" not in payload:
        fail("MCP response had no result")
    return payload["result"]


def unwrap_tool(result):
    if isinstance(result, dict) and result.get("isError"):
        fail(json.dumps(result, ensure_ascii=False))
    content = result.get("content") if isinstance(result, dict) else None
    if not isinstance(content, list) or not content:
        return result
    first = content[0]
    if not isinstance(first, dict) or first.get("type") != "text" or "text" not in first:
        return result
    text = first["text"]
    if not isinstance(text, str):
        return result
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def cmd_account(args):
    result = rpc(args.base, args.token, "tools/call", {"name": "get_account", "arguments": {}})
    emit(unwrap_tool(result))


def cmd_send(args):
    result = rpc(
        args.base,
        args.token,
        "tools/call",
        {"name": "send_email", "arguments": {"to": args.to, "subject": args.subject, "body": args.body}},
    )
    emit(unwrap_tool(result))


def cmd_tools(args):
    emit(rpc(args.base, args.token, "tools/list"))


def cmd_health(args):
    emit(http_json("GET", os.environ.get("MAIL_HEALTH_URL") or DEFAULT_HEALTH_URL))


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--url",
        default=os.environ.get("MCP_URL") or DEFAULT_BASE,
        help="Gateway origin. Defaults to MCP_URL, then https://abot.run. A trailing /mcp is stripped.",
    )

    parser = argparse.ArgumentParser(
        prog="mcp_cli",
        description="Call get_account or send_email through the abot-gateway MCP endpoint. Mail is not archived.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    account = sub.add_parser("account", parents=[common], help="Call get_account.")
    account.set_defaults(func=cmd_account)

    send = sub.add_parser("send", parents=[common], help="Call send_email. Counts against the hourly recipient quota.")
    send.add_argument("--to", required=True, help="One address, or up to 10 comma-separated addresses.")
    send.add_argument("--subject", required=True)
    send.add_argument("--body", required=True)
    send.set_defaults(func=cmd_send)

    tools = sub.add_parser("tools", parents=[common], help="Call tools/list.")
    tools.set_defaults(func=cmd_tools)

    health = sub.add_parser("health", parents=[common], help="GET mail.abot.run/health (or MAIL_HEALTH_URL). No token.")
    health.set_defaults(func=cmd_health)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.base = worker_base(args.url)
    args.token = None if args.cmd == "health" else env_token()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as err:
        fail(str(err))


if __name__ == "__main__":
    main()
