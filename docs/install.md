# 安装说明已停用

旧的安装步骤会创建 D1 邮件表、R2 桶、`mail-ingest` 队列，并把 Resend webhook 接到存档消费者。当前分支不再做这些事。

需要的线上资源只剩：

- Worker `resend-agent-mail-relay`，路由 `mail.abot.run/*`，`workers.dev` 关闭
- 已有 D1 `abot-mail-archive`（只当 `rate_limits` 用；不要删历史表，除非单独决定销毁数据）
- Secrets：`WEBHOOK_SECRET`、`RESEND_API_KEY`

不要新建 R2、队列或 Workers AI binding。不要把这份仓库当成从零装存档的 runbook。
