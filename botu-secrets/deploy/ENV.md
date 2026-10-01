# botu-secrets 部署环境

Worker 入口是 `src/worker.js`（单文件，无构建步骤）。独立域名 `secrets.abot.run`，路由在根路径：`POST /mcp`、`GET /health`。没有 `/secrets` 前缀。

代码只从下面这些绑定读配置。KEK 由部署方生成后注入，仓库和镜像里不放密钥。

## 清单

| 名称 | 类型 | 必须 | 说明 |
| --- | --- | --- | --- |
| `KEK_B64` | secret | 是 | 32 字节 AES-256 密钥的标准 base64（带 `+` `/` `=`，不要用 base64url，不要换行）。缺失、非法 base64、或解码后不是 32 字节时，已带 Bearer 的 `POST /mcp` 直接抛 `KekError`，拒绝服务。 |
| `DB` | D1 binding | 是 | 绑定名必须是 `DB`。库名建议 `botu-secrets`。表结构用仓库里的 `schema.sql`（可重复执行）。 |

没有其他 env 依赖。不读取 `DATA_MCP_TOKEN`、邮件归档或其他 Worker 的 secret。

`GET /health` 不读 KEK，也不读 D1。未带 `Authorization` 的 `POST /mcp` 在查 KEK 和 D1 之前就返回 HTTP 401。

## 生成 KEK

```bash
openssl rand -base64 32 | tr -d '\n'
```

解码后必须刚好 32 字节。注入（不要写进 wrangler.toml 的 vars）：

```bash
npx wrangler secret put KEK_B64 --env staging
```

## 建库

`wrangler.toml` 里的 `database_id` 是占位符，不是真实库。创建 D1 后把 staging 的 `database_id` 换成真实 id，再执行：

```bash
npx wrangler d1 execute botu-secrets --env staging --file=schema.sql
```

## 第一把运维 token

`create_bot` 只能造 `is_ops=0` 的 bot。第一把 ops token 要直接写入 `bots`。明文 token 不要入库，只存 SHA-256 hex。

```bash
node --input-type=module -e '
import { createHash, randomBytes } from "node:crypto";
const token = randomBytes(32).toString("base64url");
const token_hash = createHash("sha256").update(token).digest("hex");
const created_at = new Date().toISOString();
console.log("token (show once):", token);
console.log("token_hash:", token_hash);
console.log("created_at:", created_at);
'
```

把输出里的 hash 填进 SQL（`id` 用 `bot_` + 12 位 `[a-z0-9]`）：

```sql
INSERT INTO bots (id, name, token_hash, is_ops, revoked, created_at)
VALUES ('bot_ops000000000', 'ops', '<token_hash>', 1, 0, '<created_at>');
```

建议再种子一把备用 ops。`revoke_bot` 会把目标 bot 标成 `revoked=1`，没有解封工具。

ops 可以 `list_secrets` 看全部元数据。`get_secret` 仍要有对应 scope 的 `grants` 行，包括 ops 自己。需要读明文时先 `grant_access`。

## 发布

```bash
npx wrangler deploy --env staging
```

把 `secrets.abot.run/*` 指到这个 Worker。确认：

- `GET https://secrets.abot.run/health` → `{"ok":true,"service":"botu-secrets"}`
- 不带 token 的 `POST https://secrets.abot.run/mcp` → HTTP 401
