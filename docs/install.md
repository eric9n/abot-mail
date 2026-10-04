# 从零安装 abot-mail

这份 runbook 给**另一个已经有 Cloudflare 凭证的 agent**。按顺序做。每一步都写了做什么、用哪条命令或 API、预期输出、以及怎么验证。

账号、域名、密钥全部用尖括号占位符。文末「参考值」是**本仓库当前生产部署的例子**，用来对照名字，不是让你把生产 id 填进新账号。

> 这份 runbook 只用于在**另一个** Cloudflare 账号里从零搭一套。生产 Worker `resend-agent-mail-relay` 不按这里部署，它唯一的发布路径是 Cloudflare 控制台的 Workers Builds（见 README「部署」）。另外，`POST /mcp` 现在只接受 Service Binding 的内部 host `backend.internal`，从 workers.dev 或自定义域名直接调 `/mcp` 一律 404。下文用公网 URL 和 `MCP_TOKEN` 验证 MCP 的步骤已经不适用，需要通过一个带 Service Binding 的网关 Worker 来验证。

不要改 Worker 的行为，不要加发送邮件的工具。服务是只读归档：Resend webhook → 验签 → 队列 → D1/R2 → `POST /mcp`。

## 前置条件

- 一个 Cloudflare 账号，能用 Workers、D1、R2、Queues、Workers AI、Analytics Engine。
- API token，权限至少覆盖：Workers Scripts 编辑、D1 编辑、Workers R2 Storage 编辑、Queues 编辑、Account Settings 读取。下文称 `<CLOUDFLARE_API_TOKEN>`。
- 可选：`npx wrangler` 或 `cf` CLI 已登录。CLI 不是必须的。下面每一步都有 HTTPS API。`cf` 的 401 坑在文末。
- Resend 账号，API key `<RESEND_API_KEY>`，以及一个你能改 DNS 的域名 `<MAIL_DOMAIN>`（用来收 `email.received`，也用来发 `email.sent`）。
- 本仓库的 `worker/worker.js`（单个 ES module，没有别的本地 import）和 `worker/schema.sql`。
- 能从外部邮箱往 `<MAIL_DOMAIN>` 发一封信，供最后的全链路验证。

生成密钥，不要写进 git：

```bash
openssl rand -base64 32    # 用作 <MCP_TOKEN>
openssl rand -base64 32    # 用作 <INTERNAL_TOKEN>
```

`<WEBHOOK_SECRET>` 先空着。它是创建 Resend webhook 之后返回的 `signing_secret`（`whsec_` 开头），原样放进 Worker，不要自己去掉前缀。

有 JSON body 的请求带 `Content-Type: application/json`。Cloudflare 再加 `Authorization: Bearer <CLOUDFLARE_API_TOKEN>`，Resend 改用 `Authorization: Bearer <RESEND_API_KEY>`。没有 body 的 GET 不必带 `Content-Type`。

```bash
-H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>"
-H "Content-Type: application/json"
```

第 6 步的脚本上传是 multipart（`-F`），不要加 `Content-Type: application/json`。curl 会自己带 `multipart/form-data` 和 boundary；这个 JSON 头会盖掉 boundary，上传失败。

Cloudflare 的成功响应是 `{"success":true,"result":...}`。`success` 不是 `true` 就停，看 `errors`，不要继续下一步。

## 占位符

| 占位符 | 含义 |
| --- | --- |
| `<ACCOUNT_ID>` | Cloudflare account id |
| `<CLOUDFLARE_API_TOKEN>` | 调 `api.cloudflare.com` 的 Bearer token |
| `<WORKER_NAME>` | Worker 脚本名。生产例子见文末，新账号自己起名 |
| `<WORKERS_SUBDOMAIN>` | 账号的 workers.dev 子域，不含 `.workers.dev` |
| `<D1_DATABASE_ID>` | 创建 D1 之后返回的 `result.uuid` |
| `<MAIL_INGEST_QUEUE_ID>` | 队列 `mail-ingest` 的 `queue_id` |
| `<MAIL_INGEST_DLQ_ID>` | 队列 `mail-ingest-dlq` 的 `queue_id` |
| `<RESEND_API_KEY>` | Resend API key |
| `<WEBHOOK_SECRET>` | webhook 的 `signing_secret`，形如 `whsec_...` |
| `<MCP_TOKEN>` | 自行生成的长随机串，只用于 `POST /mcp` 的 Bearer |
| `<INTERNAL_TOKEN>` | 自行生成的长随机串，Worker secret。设了之后 `POST /mcp` 接受 `X-Internal-Token` |
| `<MAIL_DOMAIN>` | 收件域名，须开通 Resend receiving |
| `<RESEND_DOMAIN_ID>` | Resend 域名 id |
| `<ALERT_TO>` | 告警收件地址，安装者自己的邮箱。普通变量，不是 secret |
| `<ALERT_FROM>` | 告警发件人，须是 `<MAIL_DOMAIN>` 上已验证的地址。普通变量，不是 secret |
| `<AGENT_SKILLS_DIR>` | 这个 agent 实际加载 skill 的目录 |

Worker 的公开 origin 是：

`https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev`

绑定名字必须和 `worker/wrangler.toml` 一致，不要改：

| 绑定 | 类型 | 名字 |
| --- | --- | --- |
| `DB` | D1 | 库名 `abot-mail-archive` |
| `ARCHIVE_BUCKET` | R2 | 桶名 `abot-mail-archive` |
| `INGEST_QUEUE` | Queue producer | 队列 `mail-ingest` |
| `AI` | Workers AI | 无外部 key |
| `METRICS` | Analytics Engine | dataset `mail_metrics` |

密钥是 Worker secret，用 `secret_text` / `wrangler secret put` 写入，不要放进 `[vars]` 或 metadata 的 `plain_text`：`WEBHOOK_SECRET`、`RESEND_API_KEY`、`MCP_TOKEN`、`INTERNAL_TOKEN`。`INTERNAL_TOKEN` 可以后补；没设时只有 Bearer 能进 `/mcp`。设了之后，请求头 `X-Internal-Token` 必须和整个 secret 逐字符相同才算通过。

## 分步安装

### 1. 创建 D1 `abot-mail-archive`

**做什么。** 在这个账号里新建 D1，名字固定为 `abot-mail-archive`。记下 uuid，后面的绑定和建表都用它。

**命令。**

```bash
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/d1/database" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"abot-mail-archive"}'
```

等价的 CLI：`npx wrangler d1 create abot-mail-archive`。若 `cf d1 create` 返回 401，而 token 本身是好的，改走上面的 API，见故障排查。

**预期输出。** `success: true`，`result.name` 为 `abot-mail-archive`，`result.uuid` 是 `<D1_DATABASE_ID>`。

**验证。**

```bash
curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/d1/database/<D1_DATABASE_ID>" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>"
```

`result.name` 仍是 `abot-mail-archive`。

### 2. 逐条执行 `worker/schema.sql`

**做什么。** 在刚建的库上执行 `worker/schema.sql`。用单条 query 接口。**batch 端点不可用**，不要调用带 batch 的路径，也不要一次 POST 多条语句。`npx wrangler d1 execute --file=schema.sql` 有可能走 batch，这里不要用它建表。

`schema.sql` 里的 `CREATE TABLE IF NOT EXISTS` 可以重复执行，不会清空已有行。触发器体内部有分号，必须整段作为一条 `sql` 送出。

**命令。** 把下面 9 段分别存成 `/tmp/abot-mail-schema/01.sql` … `09.sql`（放在仓库外面）。然后对每个文件 POST 一次。

`01.sql`：

```sql
CREATE TABLE IF NOT EXISTS emails (
  resend_id   TEXT PRIMARY KEY,
  direction   TEXT NOT NULL,
  msg_from    TEXT,
  msg_to      TEXT,
  cc          TEXT,
  subject     TEXT,
  date        TEXT,
  text_body   TEXT,
  html_body   TEXT,
  message_id  TEXT,
  auth        TEXT,
  attachments TEXT,
  summary     TEXT,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_read     INTEGER DEFAULT 0,
  deleted_at  INTEGER,
  is_archived INTEGER DEFAULT 0
);
```

`02.sql`：

```sql
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
```

`03.sql`：

```sql
CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(msg_from);
```

`04.sql`：

```sql
CREATE TABLE IF NOT EXISTS ingest_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  resend_id   TEXT,
  event_type  TEXT,
  error       TEXT,
  attempts    INTEGER,
  failed_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

`05.sql`：

```sql
CREATE INDEX IF NOT EXISTS idx_ingest_failures_resend_id ON ingest_failures(resend_id);
```

`06.sql`：

```sql
CREATE TABLE IF NOT EXISTS cache_revision (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL
);
```

`07.sql`：

```sql
INSERT OR IGNORE INTO cache_revision (id, rev) VALUES (1, 0);
```

`08.sql`：

```sql
DROP TRIGGER IF EXISTS cache_revision_after_email_insert;
```

`09.sql`（一整段，不要按分号拆开）：

```sql
CREATE TRIGGER cache_revision_after_email_insert
AFTER INSERT ON emails
BEGIN
  INSERT INTO cache_revision (id, rev) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET rev = rev + 1;
END;
```

`BEGIN` 必须是大写，文件必须是 LF 换行。D1 的 query 接口按分号切语句；只有关键字是大写 `BEGIN`、并且换行是 LF，才会进入触发器模式，把 `BEGIN` 到 `END` 当成一条语句。CRLF（`\r\n`）或小写 `begin` 会被切碎，接口报 `incomplete input`。上面这段按原样保存，不要改大小写。在 Windows 上保存时用 LF，不要用记事本默认的 CRLF。下面的 `path.read_text()` 原样送出文件内容，不会改换行。

每段的请求：

```bash
python3 - <<'PY'
import json, pathlib, urllib.request
account = "<ACCOUNT_ID>"
database = "<D1_DATABASE_ID>"
token = "<CLOUDFLARE_API_TOKEN>"
url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"
for path in sorted(pathlib.Path("/tmp/abot-mail-schema").glob("*.sql")):
    body = json.dumps({"sql": path.read_text(), "params": []}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)
    print(path.name, payload.get("success"), payload.get("errors"))
    if not payload.get("success"):
        raise SystemExit(1)
    result = payload.get("result") or []
    first = result[0] if result else None
    if isinstance(first, dict) and first.get("success") is False:
        print(path.name, "statement failed", first)
        raise SystemExit(1)
PY
```

路径是 `POST /client/v4/accounts/<ACCOUNT_ID>/d1/database/<D1_DATABASE_ID>/query`。body 是 `{"sql":"...","params":[]}`。

**预期输出。** 每一段都是 `success: true`，`errors` 为 `null` 或空数组。`result[0].success` 不是 `false`。

**验证。** 再 query 一次：

```sql
SELECT name, type FROM sqlite_master
WHERE name IN (
  'emails',
  'idx_emails_date',
  'idx_emails_from',
  'ingest_failures',
  'idx_ingest_failures_resend_id',
  'cache_revision',
  'cache_revision_after_email_insert'
)
ORDER BY name;
```

7 行都在。再查 `SELECT rev FROM cache_revision WHERE id = 1`，得到 `0`。

**已经存在的库。** `CREATE TABLE IF NOT EXISTS` 不会给旧的 `emails` 加上 `is_read`、`deleted_at`、`is_archived`。缺 `deleted_at` 时，`search_emails` 和 `email_stats` 的 SELECT 会失败，MCP 收成 JSON-RPC `-32603`。新 Worker 会在读的时候探测列并尝试补上；仍然要对已有库把 `worker/migrations/mailbox-columns.sql` 里的三条 `ALTER` 各 POST 一次（一条一个请求，不要 batch）。`duplicate column name` 表示这列已经在，停在这条即可。补完后用 `fresh: true` 调一次搜索和统计。

### 3. 创建 R2 桶 `abot-mail-archive`

**做什么。** 新建桶，名字和 D1 相同：`abot-mail-archive`。Worker 里的 binding 名是 `ARCHIVE_BUCKET`，桶名是这个。

**命令。**

```bash
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/r2/buckets" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"abot-mail-archive"}'
```

或：`npx wrangler r2 bucket create abot-mail-archive`。

**预期输出。** `success: true`，`result.name` 为 `abot-mail-archive`。桶已存在时会报冲突，确认名字相同就可以继续，不要另建一个桶。

**验证。**

```bash
curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/r2/buckets/abot-mail-archive" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>"
```

返回这个桶。

### 4. 创建队列 `mail-ingest` 和死信 `mail-ingest-dlq`

**做什么。** 先建两个队列。死信先建，因为下一步消费者要引用它的名字。这一步**只建队列，不绑消费者**。消费者要等 Worker 脚本存在（第 8 步）。用 wrangler 部署时，`worker/wrangler.toml` 里的 consumer 会在 deploy 时绑上，前提是这两个队列已经存在。

**命令。**

```bash
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"queue_name":"mail-ingest-dlq"}'

curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"queue_name":"mail-ingest"}'
```

或：

```bash
npx wrangler queues create mail-ingest-dlq
npx wrangler queues create mail-ingest
```

**预期输出。** 两次都是 `success: true`。把 `mail-ingest` 的 `result.queue_id` 存成 `<MAIL_INGEST_QUEUE_ID>`，死信的存成 `<MAIL_INGEST_DLQ_ID>`。

**验证。** `GET /client/v4/accounts/<ACCOUNT_ID>/queues`，两个 `queue_name` 都在列表里。此时它们还没有 consumer，这是对的。

### 5. 启用 Analytics Engine

**做什么。** Worker 有 binding `METRICS`，dataset 名 `mail_metrics`。账号第一次用 Analytics Engine 时，必须先在 Cloudflare dashboard 里**手动创建第一个 dataset**，账号级开关才会打开。打开之后，Worker binding 声明的 dataset 在第一次写入时自动可用，不用再为 `mail_metrics` 单独调创建 API。

**命令。** 没有对应的「首次启用」API。在 dashboard 打开 Workers Analytics Engine，创建一个 dataset（名字用 `mail_metrics` 即可）。做完等它生效。

**预期输出。** dashboard 里能看到这个 dataset。若你提前执行了第 6 步的脚本上传，API 返回 HTTP 403 且错误码 `10089`，就是还没启用好。

**验证。** 等大约 1 分钟后重试失败的那个请求。403 / `10089` 消失才算过。不要删掉 `METRICS` 绑定来绕过。

### 6. 部署 Worker

**做什么。** 把 `worker/worker.js` 部署为脚本 `<WORKER_NAME>`。`compatibility_date` 用 `2026-09-01`。绑定见上面的表。脚本是 ES module。

两条路二选一。API 上传是默认路径。选了 wrangler 就不要再按第 7、8、10 步重做一遍，只核对结果。

#### 6a. Script Upload API

把 metadata 写到仓库外的 `/tmp/abot-mail-worker-metadata.json`。第一次上传**不要**放 `secret_text`。密钥在第 9 步单独写。之后再次上传时也继续省略 `secret_text`：省略不会删除已有 secret，已有 secret 会保留。不要把这份 JSON 提交进仓库。

告警地址不是 secret。`worker/worker.js` 里的默认值是 `ALERT_TO=eric@abot.run`、`ALERT_FROM=abot-mail <alerts@abot.run>`，只能用普通变量覆盖（wrangler 的 `[vars]`，这条 API 里是 `type: "plain_text"`）。不改的话，告警会发到生产邮箱；新的 Resend 账号通常也不能用 `alerts@abot.run` 当发件人。新安装默认关掉告警：`ALERT_ENABLED` 设为字符串 `false`（代码认的是 `"false"` 这四个字符，别的写法包括 `False` 和 `0` 都会发信）。关掉时 cron 仍会跑并计算信号；有越限时 invoke 日志里写 `breaches`（逗号分隔的名字），`alert_sent` 为 false，返回 `{sent:false}`，不调用 Resend。`ALERT_TO` 改成安装者自己的地址 `<ALERT_TO>`。`ALERT_FROM` 改成 `<MAIL_DOMAIN>` 上已经能发信的地址 `<ALERT_FROM>`，不要留生产默认值。以后若把 `ALERT_ENABLED` 改成 `"false"` 以外的值，cron 才会按这两个地址发信。再次上传时这三条 `plain_text` 要留在 `bindings` 里：省略 `secret_text` 不会删 secret，省略 `plain_text` 会丢掉变量，告警又回到代码里的默认地址。

```json
{
  "main_module": "worker.js",
  "compatibility_date": "2026-09-01",
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "bindings": [
    { "type": "d1", "name": "DB", "id": "<D1_DATABASE_ID>" },
    { "type": "r2_bucket", "name": "ARCHIVE_BUCKET", "bucket_name": "abot-mail-archive" },
    { "type": "queue", "name": "INGEST_QUEUE", "queue_name": "mail-ingest" },
    { "type": "ai", "name": "AI" },
    { "type": "analytics_engine", "name": "METRICS", "dataset": "mail_metrics" },
    { "type": "plain_text", "name": "ALERT_ENABLED", "text": "false" },
    { "type": "plain_text", "name": "ALERT_TO", "text": "<ALERT_TO>" },
    { "type": "plain_text", "name": "ALERT_FROM", "text": "<ALERT_FROM>" }
  ]
}
```

```bash
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -F "metadata=@/tmp/abot-mail-worker-metadata.json;type=application/json" \
  -F "worker.js=@worker/worker.js;type=application/javascript+module"
```

在仓库根目录执行，这样 `worker/worker.js` 路径是对的。multipart 的文件字段名必须是 `worker.js`，和 `main_module` 一致。这条 `curl` **不要**加 `-H "Content-Type: application/json"`。`-F` 会自己生成带 boundary 的 `multipart/form-data`；加上文那个 JSON 头会盖掉 boundary，上传失败。

**预期输出。** `success: true`。`result.startup_time_ms` 一类字段出现即可。若 `errors[].code` 是 `10089`，回到第 5 步，等约 1 分钟再 PUT。

**验证。** `GET /client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/settings`（或 GET 脚本本身）能看到脚本。再确认 `workers.dev` 还没开：API 创建的脚本默认不打开 workers.dev。第 7 步才开。

#### 6b. wrangler

只在你选择 wrangler 时做。把 `worker/wrangler.toml` 里 D1 的 `database_id` 换成 `<D1_DATABASE_ID>`。文件里如果还是别的账号的 uuid，deploy 会绑错库。不要把新账号的 id 提交回这个生产仓库，除非这次任务明确要求改 toml。

队列必须已经在第 4 步建好。在 `worker/` 目录：

```bash
npx wrangler deploy
```

wrangler 会按 toml 绑上 consumer、cron（`20 1 * * *`）并打开 workers.dev。secrets 仍然要用第 9 步，wrangler 不会从 toml 读密钥。仓库里的 `worker/wrangler.toml` 没有 `[vars]`。选这条路时在**本地** toml 加上面那三项普通变量（不要提交回这个仓库），否则 deploy 仍用代码里的 `eric@abot.run` / `alerts@abot.run`：

```toml
[vars]
ALERT_ENABLED = "false"
ALERT_TO = "<ALERT_TO>"
ALERT_FROM = "<ALERT_FROM>"
```

**预期输出。** 部署成功，并打印 `https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev`。

**验证。** deploy 命令退出码为 0。`GET /health` 只查 D1，不读 `MCP_TOKEN`、`RESEND_API_KEY`、`WEBHOOK_SECRET`、`INTERNAL_TOKEN`。secret 没设不影响 health。表和 `DB` 绑定正确时是 HTTP 200、`ok: true`。503 表示这次 D1 查询抛错（表没建完，或绑定的不是 `<D1_DATABASE_ID>`），不是缺 secret。字段核对放在文末「验证」A。

### 7. 打开 workers.dev

**做什么。** 用 API 创建的脚本默认没有 `*.workers.dev` 路由。账号还没有 workers.dev 子域时，先注册子域，再打开这个脚本。

**命令。** 先看账号子域：

```bash
curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/subdomain" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>"
```

没有子域就注册一个（名字就是 `<WORKERS_SUBDOMAIN>`）：

```bash
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/subdomain" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"<WORKERS_SUBDOMAIN>"}'
```

然后打开**这个脚本**：

```bash
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/subdomain" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

body 就是 `{"enabled":true}`。

**预期输出。** `success: true`，`result.enabled` 为 `true`。

**验证。** 再 GET 同一个 `/workers/scripts/<WORKER_NAME>/subdomain`，`enabled` 仍是 `true`。浏览器或 curl 访问 `https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/health` 应得到 JSON，而不是 Cloudflare 的找不到主机。`/health` 不读 `MCP_TOKEN`、`RESEND_API_KEY`、`WEBHOOK_SECRET`、`INTERNAL_TOKEN`，secret 没设也不影响结果。表和 `DB` 绑定正确时是 HTTP 200、`ok: true`。503、`ok: false` 表示 D1 查询抛错（建表或绑定问题），不是缺 secret。字段是否完整放在文末「验证」A。

用 wrangler 部署的跳过本步，只做这条 GET 核对。

### 8. 把消费者指到 Worker，并给主队列绑 DLQ

**做什么。** `mail-ingest` 的消费者是这个 Worker，死信队列是 `mail-ingest-dlq`。死信队列自己还有一个消费者（同一个脚本），它不再套一层 DLQ。设置与 `worker/wrangler.toml` 一致。wrangler 的 `max_batch_timeout = 1` 单位是秒，API 的 `max_wait_time_ms` 用毫秒，所以是 `1000`，不是 `1`。

**命令。** 主队列：

```bash
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues/<MAIL_INGEST_QUEUE_ID>/consumers" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "worker",
    "script_name": "<WORKER_NAME>",
    "dead_letter_queue": "mail-ingest-dlq",
    "settings": {
      "batch_size": 1,
      "max_retries": 5,
      "max_wait_time_ms": 1000,
      "max_concurrency": 2,
      "retry_delay": 60
    }
  }'
```

死信队列（不要带 `dead_letter_queue` 字段）：

```bash
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues/<MAIL_INGEST_DLQ_ID>/consumers" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "worker",
    "script_name": "<WORKER_NAME>",
    "settings": {
      "batch_size": 1,
      "max_retries": 3,
      "max_wait_time_ms": 1000,
      "max_concurrency": 1
    }
  }'
```

`dead_letter_queue` 填队列**名字** `mail-ingest-dlq`。路径里的 id 用第 4 步的 `queue_id`。脚本必须已经在第 6 步创建，否则这里会失败。

**预期输出。** 两次 `success: true`。主队列的 `result.dead_letter_queue` 是 `mail-ingest-dlq`，`result.script_name` 是 `<WORKER_NAME>`。死信消费者没有自己的死信队列。

**验证。**

```bash
curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues/<MAIL_INGEST_QUEUE_ID>/consumers" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>"
```

对 DLQ 再 GET 一次。各有一个 worker consumer，`script_name` 正确。wrangler 已经绑过的，GET 能看到就不要再 POST，重复创建会报已经存在。

### 9. 写入 secrets

**做什么。** 写入 `RESEND_API_KEY`、`MCP_TOKEN` 和 `INTERNAL_TOKEN`。三个都是 `secret_text`，不是 `plain_text`。`WEBHOOK_SECRET` 等第 11 步拿到 `signing_secret` 再写。`INTERNAL_TOKEN` 和 `MCP_TOKEN` 一样是长随机串，只放在 Worker secret 里。网关调用 `POST /mcp` 时带 `X-Internal-Token: <INTERNAL_TOKEN>`；普通 MCP 客户端继续用 Bearer `MCP_TOKEN`。

再次上传脚本时，metadata 里不要带这些 `secret_text`。省略 `secret_text` **不会**删掉已经写入的 secret。

**命令。** 每个 secret 一次 PUT：

```bash
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/secrets" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"RESEND_API_KEY","text":"<RESEND_API_KEY>","type":"secret_text"}'

curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/secrets" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"MCP_TOKEN","text":"<MCP_TOKEN>","type":"secret_text"}'

curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/secrets" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"INTERNAL_TOKEN","text":"<INTERNAL_TOKEN>","type":"secret_text"}'
```

wrangler 等价命令（在 `worker/` 目录，交互式粘贴，不要把值写进 shell 历史以外的文件）：

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MCP_TOKEN
npx wrangler secret put INTERNAL_TOKEN
```

**预期输出。** `success: true`。`result.name` 是 secret 的名字，`result.type` 是 `secret_text`。响应里**没有** secret 的明文。

**验证。** 列出 secret 名字（不是值）：

```bash
curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/secrets" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>"
```

现在应有 `RESEND_API_KEY`、`MCP_TOKEN` 和 `INTERNAL_TOKEN`。第 11 步之后再加上 `WEBHOOK_SECRET`。列表里只有名字，没有值。

### 10. 配置 cron `20 1 * * *`

**做什么。** 每天 01:20 UTC 跑一次 scheduled handler。这是告警 cron，不新增 secret。收件人、发件人和开关是第 6 步的普通变量：`ALERT_ENABLED` 为字符串 `false` 时 cron 仍会跑并记下越限的信号名，但不会调用 Resend 发信。表达式是五段：`20 1 * * *`。

**命令。** body 是**裸数组**。不要包一层 `{"schedules":[...]}`。

```bash
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/schedules" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '[{"cron":"20 1 * * *"}]'
```

**预期输出。** `success: true`，`result.schedules` 里有且只有一条，`cron` 为 `20 1 * * *`。这个 PUT 会换成列表里的全部 cron；不要留空数组，空数组会删掉触发器。

**验证。** `GET` 同一个 `/schedules`，仍然只有 `20 1 * * *`。wrangler 部署过的，GET 到这一条即可，不必再 PUT。

### 11. 把 Resend webhook 指到 Worker

**做什么。** 在 Resend 开通 `<MAIL_DOMAIN>` 的收件，把 webhook 打到 Worker 的 `/`，只订阅 `email.received` 和 `email.sent`。其它事件类型即使打过来，验签通过后也只会 200 且不入库，但不要订阅它们。

**命令。**

1. 创建域名时就把收件打开。`POST https://api.resend.com/domains` 只传 `name` 时，响应里 `capabilities.receiving` 默认是 `disabled`，`records` 是发信记录（DKIM、`send` 子域上的 SPF），不是入站 MX。

```bash
curl -sS -X POST "https://api.resend.com/domains" \
  -H "Authorization: Bearer <RESEND_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"<MAIL_DOMAIN>","capabilities":{"sending":"enabled","receiving":"enabled"}}'
```

记下 `id`，就是 `<RESEND_DOMAIN_ID>`。域名已经存在时，用 `GET https://api.resend.com/domains` 按 `name` 找出这个 id，再 PATCH（没写的字段保持原值）：

```bash
curl -sS -X PATCH "https://api.resend.com/domains/<RESEND_DOMAIN_ID>" \
  -H "Authorization: Bearer <RESEND_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"capabilities":{"receiving":"enabled"}}'
```

2. 再 GET 这个域名，按**这次**响应改 DNS。发信记录照配，出站测试要用。入站是另一条：`records` 里 `record` 为 `Receiving MX`、`type` 为 `MX` 的那条。用它的 `name`、`value`、`priority`，不要拿 `send` 子域上那条 `feedback-smtp...` 当入站 MX。入站 MX 的 `priority` 必须是该主机上最小的数字（Resend 说的 lowest priority value）。数字更小的 MX 先收到信；已经有更小或相同的 MX 时，信进不了 Resend。根域上已经有别的邮箱时，把 `<MAIL_DOMAIN>` 换成子域，只在子域上放这条 MX。

3. DNS 写好后触发校验，然后轮询，直到收件生效。`POST /verify` 没有 JSON body，不要加 `Content-Type`。

```bash
curl -sS -X POST "https://api.resend.com/domains/<RESEND_DOMAIN_ID>/verify" \
  -H "Authorization: Bearer <RESEND_API_KEY>"

curl -sS "https://api.resend.com/domains/<RESEND_DOMAIN_ID>" \
  -H "Authorization: Bearer <RESEND_API_KEY>"
```

`POST /verify` 会把状态暂时标成 `pending`。隔一会儿重复上面的 GET。过线要同时满足：`capabilities.receiving` 是 `enabled`，`Receiving MX` 那条的 `status` 是 `verified`。域名整体 `status` 可以是 `verified`。发信记录还没过、收件已经过时会是 `partially_verified`：验证 D 可以开始，验证 E 要等发信记录也是 `verified`。停在 `not_started`、`pending` 太久或 `failed`，先核对 DNS，不要发测试信。

4. Worker 的 URL 必须已经能从公网访问（第 7 步）。创建 webhook：

```bash
curl -sS -X POST "https://api.resend.com/webhooks" \
  -H "Authorization: Bearer <RESEND_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/",
    "events": ["email.received", "email.sent"]
  }'
```

5. 响应里的 `signing_secret` 就是 `<WEBHOOK_SECRET>`。立刻写入 Worker，不要打进日志：

```bash
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/secrets" \
  -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"WEBHOOK_SECRET","text":"<WEBHOOK_SECRET>","type":"secret_text"}'
```

或 `npx wrangler secret put WEBHOOK_SECRET`。值保持 `whsec_` 前缀。

**预期输出。** Resend 返回 `object: "webhook"`、一个 id，以及 `signing_secret`。Cloudflare secret PUT 为 `success: true`，名字是 `WEBHOOK_SECRET`。

**验证。** `GET https://api.resend.com/webhooks`（同一个 Bearer），有一条 endpoint 正好是 Worker 的 `/`，events 里同时有 `email.received` 和 `email.sent`。Cloudflare secret 列表里四个名字都在：`WEBHOOK_SECRET`、`RESEND_API_KEY`、`MCP_TOKEN`、`INTERNAL_TOKEN`。

## 验证

下面全部通过才算装完。用仓库里的 `skill/mcp_cli.py`（还没复制到 agent skills 目录也没关系）。把 `<MCP_TOKEN>` 放在环境变量里，不要写进命令行参数。

### A. `GET /health`

**做什么。** 确认进程和 D1 读路径是通的。这个接口没有鉴权，也没有邮件内容。

**命令。**

```bash
curl -sS "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/health"
python3 skill/mcp_cli.py --url "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev" health
```

**预期输出。** HTTP 200，JSON 只有三个字段：`ok` 为 `true`，`last_received_at`（还没有收件时是 `null`），`count_24h` 是数字。`/health` 只查 D1，不读 `MCP_TOKEN`、`RESEND_API_KEY`、`WEBHOOK_SECRET`、`INTERNAL_TOKEN`。这些 secret 没设时，表和绑定正确仍然是这个结果。

**验证。** 两个命令的 JSON 一致。响应里没有 subject、正文、token。503、`ok: false`（`count_24h` 为 `null`）是 D1 查询抛错，去修表或绑定，不是去补 secret。

### B. `tools/list` 看到四个工具

**做什么。** 带 `MCP_TOKEN` 调 MCP。先 `initialize`，再 `tools/list`。

**命令。**

```bash
curl -sS -X POST "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/mcp" \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install","version":"0"}}}'

curl -sS -X POST "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/mcp" \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

python3 skill/mcp_cli.py --url "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev" tools
```

不带 `Authorization` 再 POST 一次 `/mcp`，应当 HTTP 401。

**预期输出。** `initialize` 的 `result.protocolVersion` 是 `2025-06-18`，`result.serverInfo.name` 是 `abot-mail-mcp`。`tools/list` 的工具名正好是 `search_emails`、`get_email`、`list_emails`、`email_stats`。没有第五个，也没有发送工具。

**验证。** 无 token 的请求是 401。四个名字与 `skill/references/tools.md` 一致。

### C. `tools/call` `email_stats`

**做什么。** 对空库做一次统计。

**命令。**

```bash
curl -sS -X POST "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/mcp" \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"email_stats","arguments":{}}}'

python3 skill/mcp_cli.py --url "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev" stats --fresh
```

**预期输出。** CLI 打出 `total`、`by_direction.in`、`by_direction.out`、`by_day`、`top_senders`。新库的 `total` 是 `0`。curl 的同一份 JSON 在 `result.content[0].text` 里。

**验证。** 没有 JSON-RPC `error`。字段集合就是上面这些。

### D. 发一封测试信，用 skill 查到归档

**做什么。** 走完 webhook → 队列 → Resend 拉取 → D1/R2 → MCP。从外部邮箱发一封到 `<MAIL_DOMAIN>` 上的任意地址，主题和正文都放同一段独特字符串 `<TEST_SUBJECT>`，带一个小附件。收件方向是 `in`。这封信必须发到第 11 步已经开通 receiving 的域名：`capabilities.receiving` 为 `enabled`，且入站 MX 的 `status` 为 `verified`。发到没开通 receiving 的域名不会产生 `email.received`。

归档是异步的。webhook 只入队并立刻 `200 {"ok":true,"queued":true}`。消费者随后才写 D1。

**命令。** 记下发信前的 `count_24h`。发信后每 15 秒查一次，最多等几分钟：

```bash
export MCP_TOKEN="<MCP_TOKEN>"
export MCP_URL="https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev"
python3 skill/mcp_cli.py health
python3 skill/mcp_cli.py search --query "<TEST_SUBJECT>" --direction in --fresh
```

搜到之后用返回的 `resend_id`：

```bash
python3 skill/mcp_cli.py get <resend_id> --include-raw-eml --fresh
```

**预期输出。** `count_24h` 比发信前大。`search` 返回的数组里有这封信的元数据，有 `has_text` / `has_html`，没有 `text_body`。`get` 的 `found` 为 `true`，`direction` 为 `in`，`text_body` 含 `<TEST_SUBJECT>`，`raw_eml` 是原文文本。附件元数据里有 `r2_key`，形如 `attachments/<resend_id>/...`。

**验证。** 三条都成立：health 计数增加、search 按主题命中、get 读到正文和 raw eml。查不到就看故障排查，不要改 `worker/worker.js`。

### E. 发一封出站测试信

**做什么。** Webhook 订了 `email.received` 和 `email.sent`。出站不走 Receiving API，消费者用 `GET /emails/{id}` 拉已发送的信。这个响应通常没有 `raw.download_url`，所以一般没有 `raw_eml`。这一步确认出站元数据和 `text_body` 能查到。

**命令。** `from` 用第 11 步发信记录已经 `verified` 的 `<MAIL_DOMAIN>`。`<OUTBOUND_TO>` 是一个能收信的地址，让 Resend 把信发出去。主题和正文用另一段独特字符串 `<TEST_SUBJECT_OUT>`，不要和入站那封重复。

```bash
curl -sS -X POST "https://api.resend.com/emails" \
  -H "Authorization: Bearer <RESEND_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "archive@<MAIL_DOMAIN>",
    "to": ["<OUTBOUND_TO>"],
    "subject": "<TEST_SUBJECT_OUT>",
    "text": "<TEST_SUBJECT_OUT>"
  }'
```

响应里的 `id` 就是 `resend_id`。和入站一样等消费者写入，然后用 skill 的 `get`：

```bash
python3 skill/mcp_cli.py search --query "<TEST_SUBJECT_OUT>" --direction out --fresh
python3 skill/mcp_cli.py get <resend_id> --fresh
```

**预期输出。** `search` 返回这封信的元数据，`direction` 为 `out`，没有 `text_body`。`get` 的 `found` 为 `true`，`text_body` 含 `<TEST_SUBJECT_OUT>`。

**验证。** 元数据和 `text_body` 都在。出站一般没有 `raw_eml`，不要把缺原文当成失败。加上 `--include-raw-eml` 时，通常是 `raw_eml: null`，并带 `raw_eml_note`（R2 里没有 `raw/<resend_id>.eml`）。对照 README「测试与部署后核对」第 6 条：`direction` 为 `out`，库里的 `auth` 为空。原文只在验证 D 的入站信上要求。

## 安装 skill

链路验证通过之后，把仓库里的 `skill/` 装到 agent 会加载的目录。目标目录的**直接子文件**是 `SKILL.md`，不要多套一层 `skill/`。

**做什么。** 复制 skill，配上 MCP server，可选地把 token 放进 Secure Vault，让 `mcp_cli.py` 在没有环境变量时还能读。

**命令。**

```bash
mkdir -p "<AGENT_SKILLS_DIR>/abot-mail"
cp -R skill/. "<AGENT_SKILLS_DIR>/abot-mail/"
python3 "<AGENT_SKILLS_DIR>/abot-mail/mcp_cli.py" --help
```

本环境如果用 hatch 加载技能，`<AGENT_SKILLS_DIR>` 往往是 `/opt/hatch/skills`。Cursor 则用那个 agent 配置里的 skills 目录。复制到一个不会被加载的路径不算装完。

MCP 客户端配置（URL 用这次安装的 origin，不要抄文末的生产地址，除非你装的就是那一套）：

```json
{
  "mcpServers": {
    "abot-mail": {
      "url": "https://<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Secure Vault：credential 名 `custom.abot-mail`，字段名 `MCP_TOKEN`，值是同一个 token。`mcp_cli.py` 只有在环境变量 `MCP_TOKEN` 不存在、且 `/opt/hatch/skills/skill-creator/bin/dynamic_credentials.py` 存在时，才调用 `add_surrogate_to_request(..., "custom.abot-mail", entry_name="MCP_TOKEN")`。环境变量优先。

`skill/mail_archive.py` 是另一条路，直接查 D1，不走这个 MCP。它要 `MAIL_ACCOUNT_ID=<ACCOUNT_ID>` 和 `MAIL_D1_ID=<D1_DATABASE_ID>`，凭证是 `custom.cloudflare` 的 `access_token`。装 skill 时一起复制，但全链路验证以 `mcp_cli.py` 为准。

**预期输出。** `--help` 退出码 0，子命令有 `search`、`get`、`list`、`stats`、`tools`、`health`。

**验证。** 在 skills 目录再跑一次 `health` 和 `stats --fresh`，结果与上面「验证」小节一致。`search --help` 里能看到 `--query`、`--from`、`--to`、`--since`、`--until`、`--direction`、`--limit`、`--include-summary`、`--fresh`。

## 故障排查

**`cf d1 create`（以及部分别的 `cf` 子命令）返回 401，但 token 是有效的。** `cf` 有时没用上你已经登录的会话。打开 `~/.config/cloudflare/config/default.json`，读取其中的 `oauth_token`，把它当作 `Authorization: Bearer` 直接调 `https://api.cloudflare.com/client/v4/...`（上面的 curl）。不要把这个 token 写进仓库、shell 历史以外的文件、或最终回复。`npx wrangler` 能成功时也可以改用 wrangler，不必跟 `cf` 耗着。

**脚本上传或第一次写 Analytics Engine 返回 HTTP 403，`errors[].code` 为 `10089`。** 账号还没启用 Analytics Engine。回到 dashboard 手动创建第一个 dataset，等约 1 分钟，再重试同一个请求。不要去掉 `METRICS` 绑定。

**API 上传成功，但 `*.workers.dev` 打不开。** 脚本默认不开 workers.dev。补第 7 步的 `POST /accounts/<ACCOUNT_ID>/workers/scripts/<WORKER_NAME>/subdomain`，body 必须是 `{"enabled":true}`。账号还没有子域时，先 `PUT /accounts/<ACCOUNT_ID>/workers/subdomain`。

**cron PUT 报 body 不合法，或 GET schedules 是空的。** body 必须是裸数组 `[{"cron":"20 1 * * *"}]`。`{"schedules":[{"cron":"20 1 * * *"}]}` 是错的。空数组会清空已有 cron。

**重新上传脚本之后 MCP 突然 401，或 webhook 突然 401。** 检查 metadata 里是不是写了空的 `secret_text`。正确做法是整段省略 `secret_text`，已有 secret 会留下。省略本身不会删除。确认 secret 列表里 `WEBHOOK_SECRET`、`RESEND_API_KEY`、`MCP_TOKEN`、`INTERNAL_TOKEN` 还在，值错了就再 PUT 一次。不要把 `INTERNAL_TOKEN` 写成 `plain_text`。

**D1 建表失败，或只建出了表、没有触发器。** 不要用 batch 端点，也不要把 `09.sql` 按分号拆开。每条语句单独 `POST .../d1/database/<D1_DATABASE_ID>/query`。触发器是一条语句。错误是 `incomplete input` 时，`BEGIN` 不是大写，或 `09.sql` 是 CRLF。改成大写 `BEGIN` 和 LF 换行，再 POST 这一段。

**消费者创建失败，提示找不到脚本。** 先完成第 6 步。死信队列必须先于主队列的 consumer 存在。`max_wait_time_ms` 用 `1000`。

**`/health` 是 503，`ok: false`。** D1 查询抛错：绑定的 id 不是 `<D1_DATABASE_ID>`，或第 2 步的表没建完。`count_24h` 在失败时会是 `null`。这和 secret 无关。`MCP_TOKEN`、`RESEND_API_KEY`、`WEBHOOK_SECRET`、`INTERNAL_TOKEN` 没设时，表和绑定正确仍然是 HTTP 200、`ok: true`。路由已经通了，修绑定或补表，不要重装账号。

**`POST /mcp` 415。** `Content-Type` 不是 `application/json`。

**webhook 一直 401，D1 没有新行。** `WEBHOOK_SECRET` 不是这个 endpoint 的 `signing_secret`，或被去掉了 `whsec_` 前缀。时间戳偏离超过 5 分钟也会 401。

**webhook 200 `{"ok":true,"queued":true}`，但 search 一直是空的。** 看第 8 步的 consumer 是否指到 `<WORKER_NAME>`，主队列的 `dead_letter_queue` 是否为 `mail-ingest-dlq`。然后看 `RESEND_API_KEY` 是否能 `GET /emails/receiving/{id}`。死信或放弃的消息在 D1 表 `ingest_failures`，用第 2 步的 query 接口 `SELECT * FROM ingest_failures ORDER BY id DESC LIMIT 5`。不要在日志里打印正文。

**Workers AI 绑定导致上传失败。** 在 dashboard 打开 Workers AI 后重新 PUT 脚本。摘要失败不会挡住归档；`get_email` 的 `summary` 可以是 `null`。

**`mcp_cli.py` 说 MCP_TOKEN 没设置。** 导出环境变量，或安装 dynamic_credentials 并把值放进 Secure Vault 的 `custom.abot-mail` / `MCP_TOKEN`。`health` 不需要 token。

## 参考值（示例）

下面是**本仓库已经上线的生产实例**，只供对照命名。新账号必须自己创建资源。不要把这些 id 或这个 endpoint 填进一套新安装，除非你的任务就是检查生产。

| 项 | 生产示例 |
| --- | --- |
| Worker 名 | `resend-agent-mail-relay` |
| Endpoint | `https://resend-agent-mail-relay.eric9n-cf.workers.dev` |
| MCP | `POST https://resend-agent-mail-relay.eric9n-cf.workers.dev/mcp` |
| D1 名 | `abot-mail-archive` |
| R2 名 | `abot-mail-archive` |
| 队列 | `mail-ingest` |
| 死信队列 | `mail-ingest-dlq` |
| Cron | `20 1 * * *`（每天 01:20 UTC） |
| Analytics Engine dataset | `mail_metrics` |
| D1 database id（生产库，不要复用） | `779058bf-f5c1-44de-b2c8-99350ec7748e` |
