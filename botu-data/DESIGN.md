# Botu 数据层 v1

个人结构化数据层，与 abot-mail 分开部署。切入点是结构化的数据：有了它，不管模型和 agent 如何变化，bot 对用户始终有用。schema 设计就是产品设计。

代码、D1、secret 都只在 `botu-data/`。不读取、不修改邮件 Worker 的代码、配置、D1、R2、队列和 secrets。

## 设计规格

### 全局规范
- ID：前缀 + 12 位随机串（`[a-z0-9]`，Worker 侧用 crypto 生成）：`cal_` 日历、`ctc_` 通讯录、`note_` 笔记。
- 时间：全存 UTC ISO8601 文本（如 `2026-09-29T04:00:00Z`）；每表带 `created_at` / `updated_at`（Worker 生成）。
- 数组字段存 JSON 文本。
- `created_by`：`human` / `bot:main`。
- 日历删除 = `status` 标 `cancelled`（留历史）；contacts / notes 硬删除。
- v1 不强校验 `attendee_ids` 存在性（允许先占位）。

### schema.sql
```sql
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  org TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  relation TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_name ON contacts(name);
CREATE INDEX idx_contacts_updated ON contacts(updated_at);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  all_day INTEGER NOT NULL DEFAULT 0,
  repeat TEXT NOT NULL DEFAULT '{"freq":"none"}',
  source TEXT NOT NULL DEFAULT 'bot',
  attendee_ids TEXT NOT NULL DEFAULT '[]',
  reminder_minutes TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  google_event_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_start ON calendar_events(start_utc);
CREATE INDEX idx_events_status ON calendar_events(status);
CREATE UNIQUE INDEX idx_events_google ON calendar_events(google_event_id)
  WHERE google_event_id IS NOT NULL;

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_notes_updated ON notes(updated_at);
```

### MCP 工具（15 个）
contacts: `create_contact({name, aliases?, org?, title?, email?, phone?, relation?, notes?})` → `{id}`；`get_contact({id})`；`list_contacts({query?, limit?})`（name/aliases/org LIKE）；`update_contact({id, ...fields})`；`delete_contact({id})`。
calendar: `create_event({title, start_utc, end_utc, timezone?, all_day?, repeat?, attendee_ids?, reminder_minutes?, location?, notes?})` → `{id}`；`get_event({id})`；`list_events({start_utc, end_utc, status?})`；`update_event({id, ...fields})`；`delete_event({id})`（实际为 status=cancelled）。
notes: `create_note({title?, body?, tags?, links?})` → `{id}`；`get_note({id})`；`list_notes({query?, tag?, limit?})`；`update_note({id, ...fields})`；`delete_note({id})`。
校验：`end_utc <= start_utc` 拒绝；`repeat` 必须是合法 JSON 且 freq ∈ {none,daily,weekly,monthly}。

### 非目标（v1 不做）
全文搜索（先 LIKE）、完整 RRULE、Google 同步（由外部 cron 做，不在 Worker 内）、多用户、大附件 R2。

## 实现说明

`schema.sql` 与上面的规格相同，语句前加了 `IF NOT EXISTS`，重复执行不会清掉已有行。

| 方法 | 路径 | 鉴权 | 作用 |
| --- | --- | --- | --- |
| `POST` | `/mcp` | `Authorization: Bearer <DATA_MCP_TOKEN>` | MCP JSON-RPC 2.0 |
| `GET` | `/health` | 无 | `{"ok":true}` |

`initialize` 的协议版本是 `2025-06-18`。`notifications/*` 回 HTTP 202 和空 body。校验失败是 JSON-RPC `-32602`，不写库。无 token 或 token 不对是 HTTP 401，发生在读 body 和 D1 之前。

行为里规格没有写死的部分：

- 三个 create 额外接受可选 `created_by`（`human` 或 `bot:main`，默认 `human`）。`source` 用表默认：contacts / notes 为 `manual`，events 为 `bot`。`created_by` 和 `source` 创建后不改。
- create 只返回 `{id}`。get 命中返回整行且 `found: true`；未命中返回 `{found: false, id}`。update 返回更新后的整行。contacts / notes 删除返回 `{id, deleted: true}`。`delete_event` 返回 `{id, status: "cancelled"}`，行仍在；再删一次仍然成功。update / delete 找不到 id 时是 `-32602` `not found`。
- 数组字段在响应里解析回数组，`repeat` 解析回对象，`all_day` 为布尔。库里仍然是 JSON 文本和 0/1。
- `list_events` 取与窗口重叠的事件：`start_utc < 窗口 end` 且 `end_utc > 窗口 start`。`status` 省略时 `confirmed` 和 `cancelled` 都返回。
- `list_contacts` / `list_notes` 的 `limit` 默认 20、最大 100。`list_events` 默认 100、最大 500。
- `repeat` 可以是对象，或一段 JSON 文本。解析后必须是对象，且 `freq` 属于 `none` / `daily` / `weekly` / `monthly`。
- `start_utc` / `end_utc` 必须是带时区的 ISO8601，写入前归一成 UTC。`timezone` 只作展示，Worker 不按它换算时间。
- `attendee_ids` 不检查 contacts 里是否存在。`list_notes` 的 `tag` 是 JSON 数组里的精确匹配，不是子串。
- `google_event_id` 不经过 MCP 写入，留给外部 cron。部分唯一索引允许多个 NULL。

Staging（不要对邮件库执行）：

```bash
cd botu-data
npx wrangler d1 create botu-data
# 把打印的 database_id 写入 wrangler.toml 的 env.staging
npx wrangler d1 execute botu-data --remote --env staging --file=schema.sql
npx wrangler secret put DATA_MCP_TOKEN --env staging
npx wrangler deploy --env staging
```

`wrangler.toml` 里的 `00000000-0000-4000-8000-000000000001` 是占位符，不是生产库，也不是邮件库。v1 不建生产 D1，不部署生产 Worker。顶层 `name` 故意不是 `botu-data`，避免不带 `--env staging` 的 deploy 把 staging Worker 覆盖成没有 D1 的版本。真正的 Worker 名在 `[env.staging]`，是 `botu-data`。
