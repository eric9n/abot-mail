---
name: abot-mail
description: >-
  经 abot-gateway（https://abot.run/mcp）查看绑定邮箱或发信。
  工具只有 get_account 和 send_email。没有邮件存档，不要搜索、读取或删除邮件。
---

# abot-mail

邮件不再归档。Webhook 验签后被忽略，Worker 不写 D1 邮件行，也不写 R2。

生产入口是网关 `POST https://abot.run/mcp`。Worker 自己的 `/mcp` 只接受 host `backend.internal`，公网 `mail.abot.run/mcp` 返回 404。

工具只有：

| 工具 | 作用 |
| --- | --- |
| `get_account` | 返回绑定邮箱 |
| `send_email` | 从绑定的 `@abot.run` 地址发信。`to`、`subject`、`body` 必填。发件人不能冒充别人。每小时按收件人数配额。 |

`search_emails`、`get_email`、`list_emails`、`email_stats`、已读、删除、归档、附件工具都已删除，调用得到 `-32601`。

```bash
export MCP_TOKEN="<网关 access token>"
python3 skill/mcp_cli.py health
python3 skill/mcp_cli.py account
python3 skill/mcp_cli.py tools
python3 skill/mcp_cli.py send --to a@example.com --subject "你好" --body "正文"
```

`GET /health` 无鉴权，响应只有 `{"ok":true}`。

不要把 `MCP_TOKEN`、`WEBHOOK_SECRET`、`RESEND_API_KEY` 写进仓库或回复。没有 `skill/mail_archive.py`。
