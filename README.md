# abot-mail

abot.run 邮件永久存档：Resend webhook → Cloudflare Worker → D1+R2，附带 MCP 服务供 AI 读取。

## 目录

- `worker/` — Cloudflare Worker 路由骨架（`worker.js`）、Wrangler 配置（`wrangler.toml`）与 D1 建表语句（`schema.sql`）
- `skill/` — Agent skill 占位，后续任务再填

当前只有路由占位：`POST /` 返回 200，`POST /mcp` 返回 501，`GET /health` 返回 `{"ok":true}`。Webhook 验签与 MCP 逻辑尚未实现。

## 部署

步骤占位，业务逻辑落地后再补完整流程。

1. 在 `worker/` 目录用 Wrangler 部署：`npx wrangler deploy`
2. 应用 D1 schema：`npx wrangler d1 execute abot-mail-archive --remote --file=schema.sql`
3. 在 Cloudflare 后台为 Worker `resend-agent-mail-relay` 设置以下 secrets。只在后台配置，绝不写入仓库、`.dev.vars` 或提交记录：
   - `WEBHOOK_SECRET` — Resend webhook 的 Svix 签名密钥
   - `RESEND_API_KEY` — Resend API key
   - `MCP_TOKEN` — MCP 访问令牌
