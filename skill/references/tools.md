# MCP 工具参数

来源是 `worker/worker.js` 的 `TOOLS`。`inputSchema.additionalProperties` 都是 `false`。

## get_account

返回当前绑定的邮箱。不接受参数。

```json
{ "email": "agent@abot.run", "domain": "abot.run" }
```

## send_email

经 Resend 从绑定的 `@abot.run` 地址发信。不把邮件写入存档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `to` | string | 是 | 一个地址，或最多 10 个逗号分隔的地址。重复地址按小写合并。 |
| `subject` | string | 是 | 一行，最多 998 个字符。 |
| `body` | string | 是 | 纯文本，最多 100000 个字符。 |
| `from` | string | 否 | 必须等于绑定邮箱，否则拒绝。 |

每个邮箱每个整点小时最多 50 个收件人（Worker 变量 `SEND_HOURLY_LIMIT` 可改）。超出返回 JSON-RPC `-32003`。Resend 拒收或配额存储不可用时不计入，或退回这一次的计数。

下面这些名字不再存在：`search_emails`、`get_email`、`list_emails`、`email_stats`、`set_email_read_status`、`delete_email`、`set_email_archived_status`、`list_attachments`、`get_attachment`。
