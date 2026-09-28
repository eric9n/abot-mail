#!/usr/bin/env python3
"""Read the abot.run mail archive from Cloudflare D1.

Subcommands follow the MCP tools: search, get, list, stats.
Account and database ids come from MAIL_ACCOUNT_ID / MAIL_D1_ID or --account / --db.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CREDENTIAL = "custom.cloudflare"
HOSTS = ["api.cloudflare.com"]

SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
RESEND_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
DATE_ONLY = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
ISO_TS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})\Z")

METADATA_SELECT = """
  resend_id,
  direction,
  msg_from,
  msg_to,
  cc,
  subject,
  date,
  message_id,
  attachments,
  created_at,
  CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text,
  CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html
""".strip()


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def cf_call(method, path, body=None):
    sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
    import dynamic_credentials as dc

    url = "https://api.cloudflare.com" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    )
    if data:
        req.add_header("Content-Type", "application/json")
    dc.add_surrogate_to_request(req, CREDENTIAL, entry_name="access_token", allowed_hosts=HOSTS)
    try:
        return dc.read_json_response(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        fail(f"Cloudflare API HTTP {err.code}: {detail}")
    except urllib.error.URLError as err:
        fail(f"Cloudflare API request failed: {err.reason}")


def require_target(args):
    account = args.account or os.environ.get("MAIL_ACCOUNT_ID")
    database = args.db or os.environ.get("MAIL_D1_ID")
    if not account or not database:
        fail("MAIL_ACCOUNT_ID and MAIL_D1_ID are required (or pass --account and --db)")
    if not SAFE_ID.fullmatch(account):
        fail("MAIL_ACCOUNT_ID has unexpected characters")
    if not SAFE_ID.fullmatch(database):
        fail("MAIL_D1_ID has unexpected characters")
    return account, database


def d1_query(account, database, sql, params):
    # Cloudflare's documented params array is strings.
    body = {"sql": sql, "params": [str(p) for p in params]}
    path = "/client/v4/accounts/{}/d1/database/{}/query".format(
        urllib.parse.quote(account, safe=""),
        urllib.parse.quote(database, safe=""),
    )
    payload = cf_call("POST", path, body)
    if not isinstance(payload, dict) or not payload.get("success"):
        errors = payload.get("errors") if isinstance(payload, dict) else payload
        fail("Cloudflare API error: " + json.dumps(errors, ensure_ascii=False))
    result = payload.get("result") or []
    if not result:
        return []
    first = result[0]
    if isinstance(first, dict) and first.get("success") is False:
        fail("D1 query failed: " + json.dumps(first, ensure_ascii=False))
    if isinstance(first, dict):
        return first.get("results") or []
    fail("D1 query returned an unexpected result")


def like_contains(value):
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def canonical_bound(value, edge):
    if DATE_ONLY.fullmatch(value):
        return f"{value}T23:59:59.999Z" if edge == "end" else f"{value}T00:00:00.000Z"
    if not ISO_TS.fullmatch(value):
        fail(f"{value} is not an ISO8601 date")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    millis = dt.microsecond // 1000
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis:03d}Z"


def clamp_limit(limit):
    if limit is None:
        return 20
    if limit < 1:
        fail("limit must be >= 1")
    return min(limit, 100)


def parse_json_field(value, fallback):
    if value is None or value == "":
        return fallback
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def flag(value):
    return value in (True, 1, "1")


def to_metadata(row):
    return {
        "resend_id": row.get("resend_id"),
        "direction": row.get("direction"),
        "from": row.get("msg_from"),
        "to": parse_json_field(row.get("msg_to"), []),
        "cc": parse_json_field(row.get("cc"), []),
        "subject": row.get("subject"),
        "date": row.get("date"),
        "message_id": row.get("message_id"),
        "has_text": flag(row.get("has_text")),
        "has_html": flag(row.get("has_html")),
        "attachments": parse_json_field(row.get("attachments"), []),
        "created_at": row.get("created_at"),
    }


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def cmd_search(args):
    account, database = require_target(args)
    if not args.query or not args.query.strip():
        fail("query is required")
    pattern = like_contains(args.query)
    where = ["(subject LIKE ? ESCAPE '\\' OR msg_from LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\')"]
    params = [pattern, pattern, pattern]
    if args.sender:
        where.append("msg_from LIKE ? ESCAPE '\\'")
        params.append(like_contains(args.sender))
    if args.to:
        where.append("msg_to LIKE ? ESCAPE '\\'")
        params.append(like_contains(args.to))
    if args.since:
        where.append("date >= ?")
        params.append(canonical_bound(args.since, "start"))
    if args.until:
        where.append("date <= ?")
        params.append(canonical_bound(args.until, "end"))
    if args.direction:
        where.append("direction = ?")
        params.append(args.direction)
    params.append(str(clamp_limit(args.limit)))
    sql = f"""SELECT {METADATA_SELECT}
FROM emails
WHERE {' AND '.join(where)}
ORDER BY date DESC, resend_id DESC
LIMIT ?"""
    emit([to_metadata(row) for row in d1_query(account, database, sql, params)])


def cmd_list(args):
    account, database = require_target(args)
    where = []
    params = []
    if args.direction:
        where.append("direction = ?")
        params.append(args.direction)
    if args.since:
        where.append("date >= ?")
        params.append(canonical_bound(args.since, "start"))
    params.append(str(clamp_limit(args.limit)))
    where_sql = ("WHERE " + " AND ".join(where) + "\n") if where else ""
    sql = f"""SELECT {METADATA_SELECT}
FROM emails
{where_sql}ORDER BY date DESC, resend_id DESC
LIMIT ?"""
    emit([to_metadata(row) for row in d1_query(account, database, sql, params)])


def cmd_get(args):
    account, database = require_target(args)
    if not RESEND_ID.fullmatch(args.resend_id) or ".." in args.resend_id:
        fail("resend_id is invalid")
    columns = METADATA_SELECT + ",\n  text_body"
    if args.include_html:
        columns += ",\n  html_body"
    sql = f"""SELECT {columns}
FROM emails
WHERE resend_id = ?"""
    rows = d1_query(account, database, sql, [args.resend_id])
    if not rows:
        emit({"found": False, "resend_id": args.resend_id})
        return
    detail = to_metadata(rows[0])
    detail["found"] = True
    detail["text_body"] = rows[0].get("text_body")
    if args.include_html:
        detail["html_body"] = rows[0].get("html_body")
    if args.include_raw_eml:
        detail["raw_eml"] = None
        detail["raw_eml_note"] = (
            f"raw/{args.resend_id}.eml is stored in R2. This CLI queries D1 only; "
            "use the MCP get_email tool with include_raw_eml to read it."
        )
    emit(detail)


def iso_utc(dt):
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def cmd_stats(args):
    account, database = require_target(args)
    since = iso_utc(datetime.now(timezone.utc) - timedelta(days=30))
    total_rows = d1_query(account, database, "SELECT COUNT(*) AS total FROM emails", [])
    direction_rows = d1_query(
        account,
        database,
        "SELECT direction, COUNT(*) AS count FROM emails GROUP BY direction",
        [],
    )
    day_rows = d1_query(
        account,
        database,
        """SELECT substr(date, 1, 10) AS day, COUNT(*) AS count
FROM emails
WHERE date >= ?
GROUP BY day
ORDER BY day ASC""",
        [since],
    )
    sender_rows = d1_query(
        account,
        database,
        """SELECT msg_from AS sender, COUNT(*) AS count
FROM emails
WHERE msg_from IS NOT NULL AND msg_from != ''
GROUP BY msg_from
ORDER BY count DESC, msg_from ASC
LIMIT 10""",
        [],
    )
    by_direction = {"in": 0, "out": 0}
    for row in direction_rows:
        if row.get("direction") in by_direction:
            by_direction[row["direction"]] = int(row.get("count") or 0)
    total = int(total_rows[0]["total"]) if total_rows else 0
    emit(
        {
            "total": total,
            "by_direction": by_direction,
            "by_day": [{"day": row.get("day"), "count": int(row.get("count") or 0)} for row in day_rows],
            "top_senders": [
                {"from": row.get("sender"), "count": int(row.get("count") or 0)} for row in sender_rows
            ],
        }
    )


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--account", help="Cloudflare account id. Defaults to MAIL_ACCOUNT_ID.")
    common.add_argument("--db", help="D1 database id. Defaults to MAIL_D1_ID.")

    parser = argparse.ArgumentParser(
        prog="mail_archive",
        description="Query the abot.run mail archive in Cloudflare D1.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    search = sub.add_parser("search", parents=[common], help="Search subject, sender, and text body.")
    search.add_argument("--query", required=True)
    search.add_argument("--from", dest="sender")
    search.add_argument("--to")
    search.add_argument("--since")
    search.add_argument("--until")
    search.add_argument("--direction", choices=("in", "out"))
    search.add_argument("--limit", type=int)
    search.set_defaults(func=cmd_search)

    get = sub.add_parser("get", parents=[common], help="Fetch one message, including its text body.")
    get.add_argument("resend_id")
    get.add_argument("--include-html", action="store_true")
    get.add_argument("--include-raw-eml", action="store_true")
    get.set_defaults(func=cmd_get)

    listing = sub.add_parser("list", parents=[common], help="List metadata, newest first.")
    listing.add_argument("--limit", type=int)
    listing.add_argument("--direction", choices=("in", "out"))
    listing.add_argument("--since")
    listing.set_defaults(func=cmd_list)

    stats = sub.add_parser("stats", parents=[common], help="Counts, last 30 days, top senders.")
    stats.set_defaults(func=cmd_stats)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as err:
        fail(str(err))


if __name__ == "__main__":
    main()
