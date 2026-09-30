# 安装 abot-mail

把下面整段交给一个**已经有 Cloudflare 凭证、可以从零建资源**的 agent。它只按 `docs/install.md` 做，做完要用验证小节的真实结果交差。

---

你的任务：在一个全新的 Cloudflare 账号上，把本仓库的 abot-mail 完整装起来。操作说明只有 `docs/install.md`。从「前置条件」做到「安装 skill」，每一步的验证都要实际跑过。不要改 `worker/worker.js` 的行为，不要发明发送邮件的工具。这是只读归档：Resend webhook → 队列 → D1/R2 → `POST /mcp`。

先读 `docs/install.md`、`skill/SKILL.md`、`skill/references/tools.md`。脚本用仓库里的 `worker/worker.js`，表结构用 `worker/schema.sql`（按 runbook 逐条 query，不要走 batch）。

## 你要填上的参数

没有的先生成或向账号申请。不要留着尖括号继续下一步。不要把密钥写进仓库或最终回复。

| 占位符 | 你要填的值 |
| --- | --- |
| `<ACCOUNT_ID>` | Cloudflare account id |
| `<CLOUDFLARE_API_TOKEN>` | 调 Cloudflare API 的 token。`cf` CLI 若 401，用 `~/.config/cloudflare/config/default.json` 的 `oauth_token` |
| `<WORKER_NAME>` | 新脚本名 |
| `<WORKERS_SUBDOMAIN>` | 这个账号的 workers.dev 子域 |
| `<RESEND_API_KEY>` | Resend API key |
| `<MAIL_DOMAIN>` | 用来收件、并且你能改 DNS 的域名 |
| `<MCP_TOKEN>` | `openssl rand -base64 32` 的输出 |
| `<WEBHOOK_SECRET>` | 创建 Resend webhook 之后返回的 `signing_secret`（保留 `whsec_` 前缀） |
| `<D1_DATABASE_ID>` | 创建 D1 `abot-mail-archive` 之后的 uuid |
| `<MAIL_INGEST_QUEUE_ID>` / `<MAIL_INGEST_DLQ_ID>` | 创建 `mail-ingest` 和 `mail-ingest-dlq` 之后的 queue id |
| `<AGENT_SKILLS_DIR>` | 你实际加载 skill 的目录 |
| `<TEST_SUBJECT>` | 测试信主题和正文里的独特字符串 |

文末「参考值」是生产例子（Worker `resend-agent-mail-relay`，endpoint `https://resend-agent-mail-relay.eric9n-cf.workers.dev`，D1/R2 名 `abot-mail-archive`，队列 `mail-ingest` / `mail-ingest-dlq`，cron `20 1 * * *`）。那是例子。新账号自己建资源，不要复用生产 D1 id。

## 完成标准

`docs/install.md` 的「验证」小节每一项都实际通过，并且 skill 已装到 `<AGENT_SKILLS_DIR>/abot-mail/`（目录下直接是 `SKILL.md`）：

1. `GET /health` 返回 `ok: true`，并且只有 `ok`、`last_received_at`、`count_24h`。
2. 不带 token 的 `POST /mcp` 返回 401。带 `<MCP_TOKEN>` 的 `initialize` 返回协议版本 `2025-06-18`。`tools/list` 正好四个工具：`search_emails`、`get_email`、`list_emails`、`email_stats`。
3. `tools/call` `email_stats` 返回 `total`、`by_direction`、`by_day`、`top_senders`。
4. 一封发到 `<MAIL_DOMAIN>` 的测试信走完入队和消费者。`python3 skill/mcp_cli.py search --query "<TEST_SUBJECT>" --fresh` 能查到元数据，`get` 能读到 `text_body`。收件还要 `include_raw_eml` 读到原文。
5. `skill/` 已复制到 agent 的 skills 目录，MCP 配置指向这次的 `https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/mcp`。

任何一项没通过就还没装完。最终回复里列出每个验证命令的实际结果，去掉密钥和邮件正文。安装中遇到的 API 错误码也写上，以及你怎么处理的。
