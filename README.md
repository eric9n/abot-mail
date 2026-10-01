# abot.run 邮件永久存档

项目：`abot-mail`。

Resend 的 `email.received` / `email.sent` webhook 进入 Cloudflare Worker `resend-agent-mail-relay`。验过 Svix 签名后，Worker 把 `{resend_id, event_type, received_at}` 放进队列 `mail-ingest` 并立刻返回 `200 {"ok":true,"queued":true}`。队列消费者再向 Resend API 取全文，把结构化字段写入 D1，把原始 `.eml` 和附件写入 R2。失败可重试；不能重试或重试耗尽的消息写入 D1 表 `ingest_failures`。历史邮件通过同一个 Worker 上的 MCP，或 `skill/mail_archive.py`，从这份存档里读。

存储只在已有的 Cloudflare 账号里：

| 资源 | 名称 | ID |
| --- | --- | --- |
| Worker | `resend-agent-mail-relay` | `https://resend-agent-mail-relay.eric9n-cf.workers.dev` |
| D1 | `abot-mail-archive` | `779058bf-f5c1-44de-b2c8-99350ec7748e` |
| R2 | `abot-mail-archive` | binding `ARCHIVE_BUCKET` |
| Queue | `mail-ingest` | binding `INGEST_QUEUE`；死信 `mail-ingest-dlq` |

D1 binding 名是 `DB`。密钥只放在 Worker secrets 里：`WEBHOOK_SECRET`、`RESEND_API_KEY`、`MCP_TOKEN`。

## 部署

在仓库根目录先跑测试，再在 `worker/` 里部署。

```bash
npm test
cd worker
npx wrangler queues create mail-ingest
npx wrangler queues create mail-ingest-dlq
npx wrangler d1 execute abot-mail-archive --remote --file=schema.sql
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MCP_TOKEN
npx wrangler deploy
```

Staging 使用另一套名字，不能和生产队列混用：`mail-ingest-staging`、`mail-ingest-staging-dlq`、D1 `abot-mail-archive-staging`、R2 `abot-mail-archive-staging`、Worker `resend-agent-mail-relay-staging`。绑定写在 `worker/wrangler.toml` 的 `[env.staging]`。staging 的 `database_id` 要换成 `wrangler d1 create` 打印的 id，占位符不是生产库。部署 staging 用 `npx wrangler deploy --env staging`，secrets 也加 `--env staging`。

`schema.sql` 使用 `IF NOT EXISTS`，重复执行不会清掉已有邮件。Worker 名称与现有脚本相同，部署后地址保持 `https://resend-agent-mail-relay.eric9n-cf.workers.dev`。

三个 secret：

- `WEBHOOK_SECRET`：Resend webhook 的 signing secret，形如 `whsec_` + base64。Worker 去掉前缀再 base64 解码，用原始字节做 HMAC-SHA256。
- `RESEND_API_KEY`：用来 `GET /emails/receiving/{id}`、`GET /emails/{id}`，以及两边的 attachments 列表。下载原始邮件和附件时走返回里的短时 `download_url`，不把 API key 带到 CDN。
- `MCP_TOKEN`：自行生成的长随机串，例如 `openssl rand -base64 32`。只用于 `POST /mcp`。

在 Resend 里把 webhook 指到 `https://resend-agent-mail-relay.eric9n-cf.workers.dev/`，订阅 `email.received` 和 `email.sent`。其它事件类型验签通过后直接回 200，不入库。

同一封邮件以 Resend 的 id 为主键，`INSERT OR IGNORE`。Webhook 不再返回 `duplicate:true`：去重在消费者里，已有行则跳过 Resend 和 R2。正文和附件都写完之后才插入 D1。Resend 5xx、429、网络超时、D1/R2 瞬时失败会按 60s、120s、240s 再试三次；第四次仍失败，或 Resend 返回 4xx（含 404），写入 `ingest_failures` 后确认消息。死信队列上的消息只落这张表，不再调 Resend。重放时把原来的 webhook 再投一次即可，消费者仍按 `resend_id` 去重。

对象键：

- 原始邮件：`raw/{resend_id}.eml`（收件 API 的 `raw.download_url`；发出邮件通常没有 raw）
- 附件：`attachments/{resend_id}/{filename}`，文件名会去掉路径并替换不安全字符

`date` 优先用邮件 `Date` 头，解析不到再用 API 的 `created_at`，再不行用事件时间。收件的 `auth` 保存 `{spf, dkim, dmarc}`。

## 路由

| 方法 | 路径 | 鉴权 | 作用 |
| --- | --- | --- | --- |
| `POST` | `/` | Svix 签名 | 验签后入队 `mail-ingest` |
| `POST` | `/mcp` | `Authorization: Bearer <MCP_TOKEN>` | MCP |
| `GET` | `/health` | 无 | `{"ok":true,"last_received_at":"...","count_24h":N}` |

`/health` 只返回最近一封收件的入库时间和过去 24 小时的归档条数。响应字段只有 `ok`、`last_received_at`、`count_24h`。Svix 时间戳偏离超过 5 分钟、签名对不上、或 MCP token 不对，都回 401，并且发生在读取业务数据之前。

## MCP

Streamable HTTP，单次 JSON-RPC 2.0，响应是普通 JSON。`initialize` 固定返回协议版本 `2025-06-18`。`notifications/initialized` 回 HTTP 202 和空 body。

Cursor / Claude Code：

```json
{
  "mcpServers": {
    "abot-mail": {
      "url": "https://resend-agent-mail-relay.eric9n-cf.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

工具（参数全部进 D1 的 `?` 占位符）：

| 工具 | 作用 |
| --- | --- |
| `search_emails` | `query` 对 subject / msg_from / text_body 做 `LIKE`。可选 `from`、`to`、`since`、`until`、`direction`（`in`\|`out`）、`limit`（默认 20，最大 100）。返回元数据，带 `has_text` / `has_html`，不带正文。 |
| `get_email` | 按 `resend_id` 返回元数据和 `text_body`。`include_html=true` 才带 `html_body`。`include_raw_eml=true` 从 R2 读 `raw/{resend_id}.eml`，对象不存在时在结果里注明。 |
| `list_emails` | 按 `date` 倒序的元数据。可选 `limit`、`direction`、`since`。 |
| `email_stats` | `{total, by_direction:{in,out}, by_day:[{day,count}], top_senders:[{from,count}]}`。`by_day` 是近 30 天有邮件的日期，`top_senders` 最多 10 条。 |

`YYYY-MM-DD` 会扩成当天的 UTC 起止。`%` 和 `_` 按字面量匹配。

## CLI

没有 MCP 客户端时，用 `skill/mail_archive.py`。它只查 D1 HTTP API：`POST /client/v4/accounts/{account}/d1/database/{db}/query`，body 是 `{"sql","params"}`。Cloudflare token 走调用方已经配好的保险库条目 `custom.cloudflare` / `access_token`（`dynamic_credentials`，允许的 host 只有 `api.cloudflare.com`）。token 需要能查询该账号的 D1。

`account` 和 `db` 来自环境变量或参数，脚本里不写死：

```bash
export MAIL_ACCOUNT_ID="<cloudflare account id>"
export MAIL_D1_ID="779058bf-f5c1-44de-b2c8-99350ec7748e"

python3 skill/mail_archive.py stats
python3 skill/mail_archive.py search --query "发票" --direction in --limit 20
python3 skill/mail_archive.py list --since 2026-09-01
python3 skill/mail_archive.py get 435eb30a-d52d-4f7c-a400-ccac381b7cc4 --include-html
```

成功时把 JSON 打到 stdout。失败时把错误打到 stderr，退出码非 0。`--include-raw-eml` 会在 JSON 里说明原始邮件在 R2 的键；读 `.eml` 字节用 MCP 的 `get_email`。

## Skill 布局

给 agent 用的邮件归档 skill 都在 `skill/`。从零把整套服务装到新 Cloudflare 账号，看 `docs/install.md`。把安装任务交给另一个 agent 时，用仓库根的 `PROMPT.md`。

| 路径 | 作用 |
| --- | --- |
| `skill/SKILL.md` | 何时使用、MCP 端点、Bearer 鉴权、只读规则 |
| `skill/mcp_cli.py` | 调 Worker `POST /mcp`。子命令 `search` / `get` / `list` / `stats` 对应四个工具，另有 `tools` 和免鉴权的 `health` |
| `skill/references/tools.md` | 四个工具的参数表，与 Worker 的 `TOOLS` 一致 |
| `skill/mail_archive.py` | 不经过 Worker，直接查 D1。读不到 R2 上的 `.eml` 字节 |

## 测试与部署后核对

`npm test` 用 `node --test` 覆盖三块纯逻辑，并用内存 SQLite 执行 `schema.sql` 和同一套 SQL：

- Svix：合法签名、伪造签名、多签名里有一个合法、改过的 body、超过 5 分钟的时间戳
- JSON-RPC：`initialize`、`tools/list`、`tools/call`、未知方法、缺参数、未知工具；HTTP 层在解析 JSON 之前拒绝错误的 Bearer
- SQL 构造器：占位符、`LIKE` 转义、limit 上限，以及插入 / 搜索 / 读取 / 统计能在 schema 上跑通

这里没有 Cloudflare token，也没有对 Resend 或线上 D1/R2 发请求。部署完成后在你自己的环境核对：

1. `curl -sS https://resend-agent-mail-relay.eric9n-cf.workers.dev/health`  
   得到 `ok: true`。响应里只有 `ok`、`last_received_at`、`count_24h`。
2. 不带 token 的 `POST /mcp` 返回 401。带 `MCP_TOKEN` 调用 `initialize`，`protocolVersion` 为 `2025-06-18`；再调 `tools/list`，能看到四个工具。
3. 用错误的 `svix-signature` 向 `/` 发 POST，返回 401，D1 行数不变。
4. 向任意 `xxx@abot.run` 发一封带附件的邮件，并确认 Resend 已把 `email.received` 打到这个 Worker。然后：
   - `/health` 的 `count_24h` 增加，响应里仍然没有邮件内容
   - MCP `search_emails` 能按主题找到元数据，`get_email` 能读到 `text_body`
   - `include_raw_eml=true` 能读到原文；R2 里有 `raw/{resend_id}.eml` 和 `attachments/{resend_id}/...`
5. 再触发一次同一 webhook（或等 Resend 重试）。响应是 `{"ok":true,"queued":true}`，消费者跑完后 D1 里仍然只有一行。
6. 从本域发出一封邮件且 webhook 含 `email.sent` 后，`direction` 为 `out`，`auth` 为空。
7. `MAIL_ACCOUNT_ID` 和 `MAIL_D1_ID` 配好后，`python3 skill/mail_archive.py stats` 的 `total` 与 MCP `email_stats` 一致。
