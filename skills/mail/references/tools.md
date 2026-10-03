# MCP 工具

来源：`worker/worker.js` 的 `TOOLS`。下面每个工具的说明是该条目 `description` 的中文，参数来自 `inputSchema`。每个工具的 `additionalProperties` 都是 `false`。必填参数标 `*`。没有 `required` 的工具不标必填。

## search_emails

在已归档邮件中搜索。`query` 用 SQL `LIKE` 匹配主题、发件人和纯文本正文。除非 `include_summary` 为 true，结果只有元数据（`has_text` / `has_html`，不含正文）。

- `query`*（string）：在 subject、from 和 text body 中匹配的子串。
- `from`（string）：发件人子串，可选。
- `to`（string）：JSON 格式收件人列表中的子串，可选。
- `since`（string）：`date` 的包含下界，ISO8601。允许 `YYYY-MM-DD`。
- `until`（string）：`date` 的包含上界，ISO8601。允许 `YYYY-MM-DD`。
- `direction`（string，enum: `in` | `out`）
- `limit`（integer，默认 20，最小 1，最大 100）
- `include_summary`（boolean，默认 false）：附上已存储的 summary 对象。不会现生成一条。
- `is_read`（boolean）：设置后只保留已读（true）或未读（false）。
- `is_archived`（boolean）：设置后只保留已归档（true）或未归档（false）。
- `include_archived`（boolean，默认 false）：把已归档邮件包含进来。默认查询会藏起它们。
- `fresh`（boolean）：跳过缓存，重新读归档。

## get_email

按 `resend_id` 取一封已归档邮件。返回元数据（含 auth 的 spf / dkim / dmarc）、`text_body` 和已存储的 summary。不会生成或写回摘要。只有请求时才包含 `html_body`。原始 RFC822 仅在请求且不超过内联上限时内联；更大的对象返回 `r2_key`，不返回字节。

- `resend_id`*（string）
- `include_html`（boolean，默认 false）
- `include_raw_eml`（boolean，默认 false）
- `fresh`（boolean）：跳过缓存，重新读归档。

## list_emails

列出已归档邮件的元数据，最新的在前。

- `limit`（integer，默认 20，最小 1，最大 100）
- `direction`（string，enum: `in` | `out`）
- `since`（string）：`date` 的包含下界，ISO8601。
- `include_summary`（boolean，默认 false）：附上已存储的 summary 对象。不会现生成一条。
- `is_read`（boolean）：设置后只保留已读（true）或未读（false）。
- `is_archived`（boolean）：设置后只保留已归档（true）或未归档（false）。
- `include_archived`（boolean，默认 false）：把已归档邮件包含进来。默认查询会藏起它们。
- `fresh`（boolean）：跳过缓存，重新读归档。

## email_stats

归档计数：总数、入站与出站、近 30 天按日计数，以及发件人前 10。

- `fresh`（boolean）：跳过缓存，重新读归档。

## send_email

通过 Resend 发信。默认使用已绑定的 `@abot.run` 地址。

- `to`*（string）：收件人邮箱。
- `subject`*（string）：邮件主题。
- `body`*（string）：邮件正文（纯文本）。
- `from`（string）：发件人地址。默认是已绑定邮箱。必须是 `@abot.run`。

## set_email_read_status

把一封邮件标为已读或未读。

- `resend_id`*（string）：邮件的 Resend ID。
- `is_read`*（boolean）：true 为已读，false 为未读。

## delete_email

软删除一封邮件（移入垃圾箱，后续查询会滤掉）。

- `resend_id`*（string）：要删除的邮件的 Resend ID。

## set_email_archived_status

归档或取消归档。已归档邮件在默认查询里隐藏。

- `resend_id`*（string）：邮件的 Resend ID。
- `is_archived`*（boolean）：true 为归档，false 为取消归档。

## list_attachments

列出一封邮件的附件。

- `resend_id`*（string）：邮件的 Resend ID。

## get_attachment

取附件内容（base64）。

- `resend_id`*（string）：邮件的 Resend ID。
- `filename`*（string）：附件文件名。
