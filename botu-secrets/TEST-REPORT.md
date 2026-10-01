# botu-secrets 测试报告

- 命令：`cd botu-secrets && npm test`
- 运行器：Node.js `node:test`（`node --disable-warning=ExperimentalWarning --test`）
- 日期：2026-10-01
- 结果：**19 通过 / 19 用例，0 失败，0 跳过**

D1 用 `node:sqlite` 内存库，包成与生产相同的 `prepare` / `bind` / `all` / `first` / `run` 接口，再经 `d1Deps` 注入。另有一条用例不给 `env.DB`，只注入 `deps.db`。时钟用 `nowMs` 注入。KEK 用测试用的 32 字节固定值，不是部署密钥。

## 用例

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | schema.sql 可重复执行，五张表的列与规格一致，没有 DROP / ALTER | 通过 |
| 2 | README 与 deploy/ENV.md 写明 10 个工具、-32003、KEK 包裹格式 | 通过 |
| 3 | `GET /secrets/health` 公开 200；其他路径 404；方法不对 405 | 通过 |
| 4 | 未带 Authorization 的 `/secrets/mcp` 在碰数据库之前返回 401；错误 token 401；`revoked=1` 401 | 通过 |
| 5 | KEK 缺失、非法 base64、非 32 字节抛 `KekError`，且不访问 D1 | 通过 |
| 6 | initialize、tools/list（恰好 10 个工具）、未知 tool `-32601`、参数非法 `-32602`、415、400 | 通过 |
| 7 | AES-GCM 往返、AAD 绑定、`rotation_due` 严格大于、`isLeaseActive` 过期与吊销 | 通过 |
| 8 | `put_secret`：version=1、密文不含明文、重复 name 为 `-32602` | 通过 |
| 9 | `get_secret`：明文、lease、`expires_at = now+ttl`（默认 900）、审计 hash | 通过 |
| 10 | 无 grant 的 get（含 ops）为 `-32003`；普通 bot 调 9 个运维工具均为 `-32003` | 通过 |
| 11 | `list_secrets`：ops 看全部，普通 bot 只看已授权 scope；无 value / 密文；`rotation_due` 随注入时钟变化 | 通过 |
| 12 | `rotate_secret`：version+1、新 DEK 解不开旧密文、新值可解、未过期 lease `revoked=1`、已过期 lease 保持 0 | 通过 |
| 13 | `revoke_secret` 删除密文行，全部 lease `revoked=1`，再 get 为 `-32602` not found | 通过 |
| 14 | `create_bot`：32 字节熵的 base64url token 只出现在响应里，库中只有 SHA-256，`is_ops=0` | 通过 |
| 15 | `grant_access` 幂等，授权后 get 成功，未知 bot 为 not found | 通过 |
| 16 | `revoke_bot`：`bots.revoked=1`，未过期 lease 吊销，之后该 token 401 | 通过 |
| 17 | `revoke_lease`：指定行 `revoked=1`，过期判定为无效；错误 id `-32602` | 通过 |
| 18 | `audit_log` 按 bot / secret 名（服务端哈希）/ action 过滤；`secret_name_hash` 等于 SHA-256(name)；审计转储里没有明文名和 value | 通过 |
| 19 | `generate_secret`：默认长度 32 且字符属于默认字符集；自定义 length/alphabet；新 DEK、version=1；明文只在本次响应；库、list、审计都不含明文；无 grant 的 get 与普通 bot 调用均为 `-32003`；有 grant 的 get 能解密；重名 `-32602` | 通过 |

## 覆盖的功能点

- 11 个工具的成功路径：`put_secret`、`generate_secret`、`get_secret`、`rotate_secret`、`revoke_secret`、`list_secrets`、`create_bot`、`grant_access`、`revoke_bot`、`revoke_lease`、`audit_log`
- `generate_secret`：`getRandomValues` 拒绝采样，默认 32 字符、`A-Za-z0-9`；自定义长度和字符集；信封与 `put_secret` 相同（新 DEK、version=1）；明文只出现在生成响应；审计动作 `generate_secret`，`secret_name_hash` 为 SHA-256(name)，detail 只有 version 和 length
- ACL：无 scope grant 的 `get_secret` 返回 `-32003`；普通 bot 调用运维工具返回 `-32003`
- Lease：get 写入 lease，`expires_at` 等于 now+ttl；`revoke_bot` / `rotate_secret` 吊销未过期 lease；`revoke_secret` 吊销全部 lease；`isLeaseActive` 把 `expires_at <= now` 或 `revoked=1` 判为无效
- 轮换：version 递增，`last_rotated_at` 更新，旧 DEK 被替换后旧密文解密失败，新值可以解密
- `revoke_secret` 之后密文行不在，get 返回 `-32602` not found
- 审计：`put_secret`、`generate_secret`、`get_secret`、`rotate_secret`、`revoke_secret`、`create_bot`、`grant_access`、`revoke_bot`、`revoke_lease` 都有审计行；secret 相关行的 `secret_name_hash` 为 SHA-256 hex；审计中无明文 secret 名、无 value、无 token
- KEK fail-closed：缺失、非法 base64、长度不是 32 字节都抛错
- HTTP：未认证 `POST /secrets/mcp` 为 401；`GET /secrets/health` 为 200 且不鉴权
