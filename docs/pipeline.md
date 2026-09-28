# 质量门禁

归档 Worker 的变更按下面五段走。任一段失败，修好之后从 Stage 1 全量重跑，不从失败的那一段接着跑。

本仓库是纯 JavaScript，没有 TypeScript，也没有 ESLint 配置。`npm run gate` 的静态检查是 `node --check`（`worker/worker.js`、`e2e/run.mjs`）和 `python3 -m py_compile`（`skill/mail_archive.py`），然后跑 `node --test`。`npm run e2e` 不在 gate 里，它要打已部署的 Worker。

## Stage 1 — `npm run gate`

在仓库根目录执行：

```bash
npm run gate
```

通过条件：语法检查和全部单元测试退出码为 0。这里不访问 Resend，也不访问 Cloudflare。E2E 脚本在缺环境变量时会失败；这条由单元测试锁住，避免空环境被当成通过。

## Stage 2 — 部署到 staging Worker

Staging 使用独立的 D1，不使用生产库 `779058bf-f5c1-44de-b2c8-99350ec7748e`。R2 也单独建桶，避免 `raw/{resend_id}.eml` 覆盖生产对象。

在 `worker/` 目录：

```bash
npx wrangler d1 create abot-mail-archive-staging
npx wrangler r2 bucket create abot-mail-archive-staging
```

把创建命令打印的 database id 写进 `worker/wrangler.toml` 的 staging 环境（生产的 `database_id` 保持不动）：

```toml
[env.staging]
name = "resend-agent-mail-relay-staging"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "abot-mail-archive-staging"
database_id = "<wrangler d1 create 输出的 id>"

[[env.staging.r2_buckets]]
binding = "ARCHIVE_BUCKET"
bucket_name = "abot-mail-archive-staging"
```

然后只对 staging 建表、写 secrets、部署：

```bash
npx wrangler d1 execute abot-mail-archive-staging --remote --env staging --file=schema.sql
npx wrangler secret put WEBHOOK_SECRET --env staging
npx wrangler secret put RESEND_API_KEY --env staging
npx wrangler secret put MCP_TOKEN --env staging
npx wrangler deploy --env staging
```

`WEBHOOK_SECRET` 是这个 staging 端点在 Resend 里的 signing secret（`whsec_` 开头）。`TEST_EMAIL_ID` 用一封已经存在的收件 id，门禁脚本不会发信。

部署完成后记下 staging 的 workers.dev 地址，作为 Stage 3 的 `WORKER_URL`。

## Stage 3 — `npm run e2e`

回到仓库根目录，对 staging 打真实链路：

```bash
export WORKER_URL="https://resend-agent-mail-relay-staging.<account>.workers.dev"
export WEBHOOK_SECRET="whsec_..."
export MCP_TOKEN="..."
export TEST_EMAIL_ID="<已存在的 Resend received email id>"
npm run e2e
```

四个变量缺任何一个，脚本会在跑用例前退出非零，并写出缺哪些。用例覆盖：

| 用例 | 期望 |
| --- | --- |
| a | 签名正确、时间戳新鲜的 `email.received` 返回 200，随后 MCP `get_email` 读到该 id 的结构化字段 |
| b | 同一请求原样再投一次，返回 `duplicate: true`，归档总数不变，正文不变 |
| c | 伪造签名返回 401；时间戳早于 5 分钟且签名本身正确也返回 401；归档总数不变 |
| d | `POST /mcp` 不带 token 返回 401；token 错误返回 401 |
| e | 正确 token 下 `search_emails` 能搜到 (a) 的邮件，`get_email` 能读到正文 |
| f | `/health` 和未鉴权的 webhook / MCP 响应都不含正文 |

脚本对 `TEST_EMAIL_ID` 做一次幂等写入。`WORKER_URL` 必须指向 Stage 2 的 staging Worker。全部通过则退出码 0；任一失败打印 `FAIL` 和用例说明，退出码非零。

## Stage 4 — 人工复核 diff

对照 `main` 看本次 diff。确认行为仍是：验签、按 Resend id 幂等入库、MCP 鉴权、`/health` 只有计数。确认 diff 里没有密钥、没有把 staging 的 database id 写进生产 binding、没有把 `WORKER_URL` 指到生产 Worker。

## Stage 5 — 合入 main

Stage 1 到 Stage 4 都通过之后，把分支合入 `main`。合入之后的生产部署仍用 `worker/wrangler.toml` 的默认环境：Worker 名 `resend-agent-mail-relay`，D1 `abot-mail-archive`（`779058bf-f5c1-44de-b2c8-99350ec7748e`）。不要把 staging 库或 staging secret 配到生产。

任一环节失败，修复后从 Stage 1 全量重跑。
