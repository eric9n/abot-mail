# abot-mail

Cloudflare Worker `resend-agent-mail-relay`（路由 `mail.abot.run/*`）。这版**不再存邮件**。

验过 Svix 签名的 `email.received` / `email.sent` webhook 直接返回 `{"ok":true,"ignored":true}`，不入队，不调 Resend 取全文，不写 D1 邮件行，不写 R2。

还在的能力：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | `{"ok":true}`。没有邮件计数。 |
| `POST` | `/` | 验签后忽略。签名不对回 401。 |
| `POST` | `/mcp` | 只接受 host `backend.internal` 且带 `x-abot-owner-email`。公网一律 404。 |

MCP 工具只剩两个：

| 工具 | 作用 |
| --- | --- |
| `get_account` | 返回这次调用绑定的邮箱。 |
| `send_email` | 用绑定的 `@abot.run` 地址经 Resend 发信。每小时按收件人数配额（默认 50）。配额在 D1 表 `rate_limits`。不把发出的信写入存档。 |

已删除、调用会得到 JSON-RPC `-32601` 的工具：`search_emails`、`get_email`、`list_emails`、`email_stats`、`set_email_read_status`、`delete_email`、`set_email_archived_status`、`list_attachments`、`get_attachment`。

## 还没做的事

这次改动不删除已经入库的邮件。生产 D1 `abot-mail-archive` 里的 `emails`、`ingest_failures`、`cache_revision`，以及 R2 桶 `abot-mail-archive` 里的对象，都还在，只是 Worker 不再读写它们。清空是另一步，确认不再需要导出之后再做。

`RULE_EVENTS` 以前在插入成功时发送。没有插入之后，它不会再响。

## 部署

生产只有 Workers Builds 这一条路径。合入 `main` 就会发布。不要在本地跑 `wrangler deploy`。

发布前在 Resend 取消指向 `https://mail.abot.run/` 的收信 webhook。代码仍会验签并回 `ignored`，但继续订阅没有意义。

`deploy/cloudflare.mjs` 会拒绝带 R2、队列、Workers AI 或 cron 的生产配置。D1 binding `DB` 必须仍指向 `779058bf-f5c1-44de-b2c8-99350ec7748e`，因为配额表在这块库里。密钥继续用 Worker secrets：`WEBHOOK_SECRET`、`RESEND_API_KEY`。

## 本地检查

```bash
npm ci
npm test
```

`npm run gate` 是 Workers Builds 的构建命令的前半段：语法检查、`skill/mcp_cli.py` 编译、全部单元测试。这里不访问 Resend，也不访问 Cloudflare。
