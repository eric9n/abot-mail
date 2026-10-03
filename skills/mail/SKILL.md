---
name: mail
description: >-
  读写 abot.run 上已绑定邮箱的归档邮件。需要搜索、查看、列出或统计邮件，发送邮件，
  标记已读或未读，软删除，归档或取消归档，以及列出或读取附件时使用。
  经网关 https://abot.run，用 abot-mcp CLI 调用 search_emails、get_email、list_emails、
  email_stats、send_email、set_email_read_status、delete_email、set_email_archived_status、
  list_attachments、get_attachment。不要直连 Worker，也不要调用源码里没有的工具。
---

# mail

## 服务简介

abot.run 邮件归档。Resend 的 `email.received` / `email.sent` webhook 进入 Worker 后入队，消费者把结构化字段写入 D1，把原始 `.eml` 和附件写入 R2。Agent 侧是 MCP server `abot-mail-mcp`（协议版本 `2025-06-18`），传输为 Streamable HTTP 上的单次 JSON-RPC 2.0。

工具定义在 `worker/worker.js` 的 `TOOLS`，参数表见 [references/tools.md](references/tools.md)。查询和写入都限制在网关带来的 `x-abot-owner-email` 这个 `@abot.run` 邮箱自己收发的信。

## 认证

经网关 `https://abot.run`，用 `abot-mcp` CLI。不要请求 Worker 的公网地址：公网入口是关的，`POST /mcp` 只接受网关的 Service Binding。

网关用绑定邮箱和 secret 向 `POST https://abot.run/oauth/token`（`grant_type=password`）换 `access_token`，再带 `Authorization: Bearer <access_token>` 调 `https://abot.run/mcp`。网关调用本 Worker 时带上 `x-abot-owner-email`。Worker 不读取 `MCP_TOKEN` 或 `INTERNAL_TOKEN`；没有合法的 `x-abot-owner-email` 时返回 401。

`abot-mcp` 负责带上网关凭证。不要在命令参数、仓库或回复里写 secret 或 access_token。

## 使用示例

`abot-mcp` 把一次 `tools/call` 发到网关。工具名和 `arguments` 只使用 [references/tools.md](references/tools.md) 里的字段；`inputSchema.additionalProperties` 为 `false`，多出来的键会被拒绝。

```bash
abot-mcp call search_emails '{"query":"发票","direction":"in","limit":20}'
abot-mcp call get_email '{"resend_id":"<resend_id>"}'
abot-mcp call list_emails '{"since":"2026-09-01","limit":20}'
abot-mcp call email_stats '{}'
abot-mcp call send_email '{"to":"a@example.com","subject":"你好","body":"正文"}'
abot-mcp call set_email_read_status '{"resend_id":"<resend_id>","is_read":true}'
abot-mcp call delete_email '{"resend_id":"<resend_id>"}'
abot-mcp call set_email_archived_status '{"resend_id":"<resend_id>","is_archived":true}'
abot-mcp call list_attachments '{"resend_id":"<resend_id>"}'
abot-mcp call get_attachment '{"resend_id":"<resend_id>","filename":"a.png"}'
```

对应的 JSON-RPC 正文：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_emails","arguments":{"query":"发票"}}}
```
