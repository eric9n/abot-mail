# botu-secrets

给 bot 用的个人密钥柜。一条 secret 一份随机数据密钥，按 scope 授权，轮换时换密钥并吊销未过期 lease，每次读取都留下审计。

这是一个 Cloudflare Worker。入口是单文件 `src/worker.js`，不需要构建。D1 表在 `schema.sql`。部署时要注入的 secret 和 binding 在 `deploy/ENV.md`。

本地逻辑不依赖 Cloudflare。WebCrypto 用全局 `crypto`，数据库通过可注入的 `queryAll` / `queryFirst` / `queryRun`。生产从 `env.DB` 走 D1，测试用内存 mock。

## 路径

生产 route 是 `mcp.abot.run/secrets/*`。Worker 只认这三个结果：

| 请求 | 结果 |
| --- | --- |
| `POST /secrets/mcp` | JSON-RPC 2.0。要 Bearer token。 |
| `GET /secrets/health` | `{"ok":true,"service":"botu-secrets"}`。不鉴权，不读库，不读 KEK。 |
| 其他路径，或方法不对 | 404 或 405。 |

## 鉴权

每个 bot 一把 token，库里只存 SHA-256 hex（`bots.token_hash`）。请求头：

```
Authorization: Bearer <token>
```

服务端对 token 做 SHA-256 再查表。查无此 bot，或 `revoked=1`，都是 HTTP 401：

```json
{"ok":false,"error":"unauthorized"}
```

没带 `Authorization` 时，在读 KEK 和 D1 之前就返回 401。

`create_bot` 造出来的 bot 一律 `is_ops=0`，明文 token 只在这一次响应里出现。第一把 ops token 要按 `deploy/ENV.md` 直接写入 `bots`（`is_ops=1`）。没有把普通 bot 提升成 ops 的工具。

## 加密

KEK 是 32 字节，放在 `env.KEK_B64`（标准 base64）。缺失、不是合法 base64、或解码后不是 32 字节时抛 `KekError`，已带 Bearer 的 MCP 请求直接失败，不继续做事。

每条 secret 单独生成 32 字节 DEK：

- `dek_wrapped_b64` = `base64( wrapNonce(12) || AES-256-GCM(KEK, DEK) )`。WebCrypto 把 16 字节 tag 接在密文后面。AAD 是 `botu-secrets.dek.v1`。
- `nonce_b64` = `base64( valueNonce(12) )`，和包裹 DEK 的 nonce 分开存。
- `ciphertext_b64` = `base64( AES-256-GCM(DEK, utf8(value)) )`。AAD 是 `botu-secrets.val.v1\n` 加上这条 secret 的 id。tag 含在密文里。

轮换会换一把新 DEK，并覆盖这三列。旧 value 不能用新 DEK 解开。

审计表只写 secret 名的 SHA-256 hex（`secret_name_hash`）。不写明文名，不写 value，不写 token，不写密钥。

## 错误码

JSON-RPC 业务错误的 HTTP 状态是 200，和 botu-data 一样。未认证是 HTTP 401，不是 JSON-RPC。

| 情况 | 结果 |
| --- | --- |
| 未认证、token 不对、bot 已吊销 | HTTP 401 `unauthorized` |
| JSON 解析失败 | HTTP 400，`-32700` |
| `Content-Type` 不是 `application/json` | HTTP 415，`-32600` |
| 未知方法、未知 tool | `-32601` |
| 参数缺失或非法、记录不存在、name 已存在 | `-32602` |
| 无权限 | `-32003`，message 为 `forbidden` |
| 其他内部失败 | `-32603` |
| KEK 缺失或非法 | 抛 `KekError`，不返回成功 |

`-32003` 用在两类拒绝上：普通 bot 调用运维工具；`get_secret` 时调用者（含 ops）没有该 secret 的 scope grant。

## Lease

`get_secret` 在返回明文的同一次调用里签发 lease。v1 的 lease 只做问责和吊销联动，不能拿它再换一次明文。过期条件是 `expires_at <= now`，或 `revoked=1`。判定函数是 `isLeaseActive`。

- `rotate_secret` 吊销该 secret 所有未过期 lease。
- `revoke_bot` 吊销该 bot 所有未过期 lease，并把 `bots.revoked` 设为 1。
- `revoke_secret` 删除密文行，并吊销该 secret 的全部 lease（含已过期的）。
- `revoke_lease` 只把指定的那一行设为 `revoked=1`。

`ttl_seconds` 默认 900，范围 1 到 86400。`expires_at = now + ttl_seconds`。

## 工具

调用形态：

```bash
curl -s https://mcp.abot.run/secrets/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_secrets","arguments":{}}}'
```

成功时 `result.content[0].text` 是 JSON 字符串。下面写的是这段 JSON 的形状。

### put_secret（ops）

`{name, scope, value, rotate_every_days?}`

新 DEK，`version=1`，`last_rotated_at=now`。`name` 已存在返回 `-32602`（`secret already exists`），改值用 `rotate_secret`。`rotate_every_days` 省略或 `null` 表示不设轮换周期；给出时是 1 到 3650 的整数。

响应：`{name, scope, version, last_rotated_at}`。没有 value。

### get_secret（需要 ACL）

`{name, ttl_seconds?}`

secret 不存在是 `-32602` `not found`。存在但调用者没有该 scope 的 grant 是 `-32003`。ops 也不例外：要读明文就先 `grant_access`。

响应：`{value, lease_id, expires_at, version}`。同时写审计，`action=get_secret`。

### rotate_secret（ops）

`{name, new_value}`

新 DEK，`version` 加 1，更新 `last_rotated_at`，吊销该 secret 未过期的 lease，写审计。

响应：`{name, version, last_rotated_at}`。没有 value。

### revoke_secret（ops）

`{name}`

删除该行（密文一起没了），吊销它的全部 lease，写审计。之后 `get_secret` 是 `not found`。

响应：`{name, deleted:true}`。

### list_secrets

参数必须是空对象。ops 看到全部元数据；普通 bot 只看到自己 grant 了的 scope。

响应是数组，元素只有：

```json
{"name":"openai","scope":"llm","version":1,"last_rotated_at":"2026-10-01T00:00:00.000Z","rotation_due":false}
```

`rotation_due` 为真当且仅当 `rotate_every_days` 非空，并且 `now - last_rotated_at` 严格大于 `rotate_every_days` 天。不返回 value、DEK 或密文。

### create_bot（ops）

`{name}`

随机 token，至少 32 字节熵，base64url。库里存 `token_hash`，`is_ops=0`，`revoked=0`。

响应：`{id, name, token, is_ops:false}`。`token` 只此一次，之后查不到明文。重名是 `-32602` `bot already exists`。

### grant_access（ops）

`{bot_name, scope}`

给这个 bot 加上 scope。bot 不存在是 `not found`。重复授予是幂等的。scope 可以先于 secret 存在。

响应：`{bot_name, scope, granted:true}`。

### revoke_bot（ops）

`{bot_name}`

`bots.revoked=1`，并吊销该 bot 未过期的 lease。之后这把 token 返回 401。没有解封工具。

响应：`{id, name, revoked:true}`。

### revoke_lease（ops）

`{lease_id}`

`leases.revoked=1`。id 必须是 `lse_` 加 12 位 `[a-z0-9]`，否则 `-32602`。不存在是 `not found`。

响应：`{lease_id, revoked:true}`。

### audit_log（ops）

`{bot_name?, secret_name?, action?}`

三个条件都可选，同时给出时是与关系。`bot_name` 先解析成 bot id 再滤 `audit.bot_id`（这是执行动作的 bot，不是被操作的 bot）。名字不存在则返回空列表。`secret_name` 传明文，服务端算 SHA-256 hex 后滤 `secret_name_hash`。

响应：`{entries:[...]}`，每行是 `{id, ts, bot_id, action, secret_name_hash, lease_id, detail}`。最多 500 行，按时间倒序。`detail` 是不含明文名和 value 的 JSON 文本。

## 本地测试

```bash
cd botu-secrets
npm test
```

需要 Node 18+ 的全局 WebCrypto。测试用 Node 自带的 `node:sqlite` 内存库模拟 D1 的 `prepare` / `bind` / `all` / `first` / `run`。不要在这个环境里跑 `wrangler deploy`。
