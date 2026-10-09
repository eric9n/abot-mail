---
name: mail
description: >-
  查看 abot.run 上绑定的邮箱，或从该邮箱发信。工具只有 get_account 和 send_email。
  没有存档，不要搜索、读取、删除、归档邮件，也不要读附件。
  经网关 https://abot.run 调用。不要直连 Worker。
---

# mail

abot.run 不再保存邮件。Agent 只能确认自己的邮箱地址，以及从绑定地址发信。

## 认证

经网关 `https://abot.run`。公网 `POST /mcp` 只接受网关的 Service Binding，直连 `mail.abot.run/mcp` 会 404。

网关带上 `x-abot-owner-email`。Worker 不读取 `MCP_TOKEN` 或 `INTERNAL_TOKEN`。

## 示例

```bash
abot-mcp call get_account '{}'
abot-mcp call send_email '{"to":"a@example.com","subject":"你好","body":"正文"}'
```

参数表见 [references/tools.md](references/tools.md)。不要调用源码里没有的工具。
