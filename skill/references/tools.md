# MCP 工具参数

来源是 `worker/worker.js` 的 `TOOLS`。含义不改。四个工具都是只读。`inputSchema.additionalProperties` 都是 `false`，未列出的参数会被拒绝。

`fresh` 在四个工具上的说明相同：Skip the cache and read the archive again. 类型 boolean，不是必填。

## search_emails

Search archived mail. query is matched with SQL LIKE against subject, sender, and plain-text body. Results are metadata only (has_text / has_html, no bodies) unless include_summary is true.

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `query` | string | 是 |  | Substring matched against subject, from, and text body. |
| `from` | string | 否 |  | Optional substring of the sender. |
| `to` | string | 否 |  | Optional substring of the JSON to list. |
| `since` | string | 否 |  | Inclusive ISO8601 lower bound on date. YYYY-MM-DD is allowed. |
| `until` | string | 否 |  | Inclusive ISO8601 upper bound on date. YYYY-MM-DD is allowed. |
| `direction` | string | 否 |  | enum: `in`, `out` |
| `limit` | integer | 否 | 20 | minimum 1, maximum 100 |
| `include_summary` | boolean | 否 | false | Attach the stored summary object. Does not generate one. |
| `fresh` | boolean | 否 |  | Skip the cache and read the archive again. |

返回元数据数组，带 `has_text` / `has_html`，不带正文。`include_summary` 为 true 时才带已存储的 summary。

## get_email

Fetch one archived email by resend_id, including text_body and summary. summary is an object or null. html_body and the raw RFC822 message are included only when requested.

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `resend_id` | string | 是 |  | |
| `include_html` | boolean | 否 | false | 为 true 时才带 `html_body`。 |
| `include_raw_eml` | boolean | 否 | false | 为 true 时从 R2 读 `raw/{resend_id}.eml`。对象不存在时在结果里注明。 |
| `fresh` | boolean | 否 |  | Skip the cache and read the archive again. |

## list_emails

List archived mail metadata, newest first.

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `limit` | integer | 否 | 20 | minimum 1, maximum 100 |
| `direction` | string | 否 |  | enum: `in`, `out` |
| `since` | string | 否 |  | Inclusive ISO8601 lower bound on date. |
| `include_summary` | boolean | 否 | false | Attach the stored summary object. Does not generate one. |
| `fresh` | boolean | 否 |  | Skip the cache and read the archive again. |

按 `date` 倒序的元数据数组。没有 cursor。

## email_stats

Archive counts: total, inbound vs outbound, daily counts for the last 30 days, and the top 10 senders.

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `fresh` | boolean | 否 |  | Skip the cache and read the archive again. |

返回：

```json
{
  "total": 0,
  "by_direction": { "in": 0, "out": 0 },
  "by_day": [{ "day": "YYYY-MM-DD", "count": 0 }],
  "top_senders": [{ "from": "sender@example.com", "count": 0 }]
}
```

`by_day` 是近 30 天有邮件的日期。`top_senders` 最多 10 条。
