# 质量门禁

归档 Worker 的变更按下面四段走。任一段失败，修好之后从 Stage 1 全量重跑，不从失败的那一段接着跑。

本仓库是纯 JavaScript，没有 TypeScript，也没有 ESLint 配置。`npm run gate` 的静态检查是 `node --check`（`worker/worker.js`、`e2e/run.mjs`、`deploy/cloudflare.mjs`）和 `python3 -m py_compile`（`skill/mail_archive.py`、`skill/mcp_cli.py`），然后跑 `node --test`。

## Stage 1 — `npm run gate`

在仓库根目录执行：

```bash
npm ci
npm run gate
```

通过条件：语法检查和全部单元测试退出码为 0。这里不访问 Resend，也不访问 Cloudflare。Workers Builds 的构建命令也是从这一步开始，所以本地不过，线上也不会部署。

## Stage 2 — 人工复核 diff

对照 `main` 看本次 diff。确认行为仍是：验签、按 Resend id 幂等入库、`/mcp` 只接受 `backend.internal` 且必须带 owner、`/health` 只有计数。确认 diff 里没有密钥，`worker/wrangler.toml` 默认环境仍指向生产资源（`deploy/cloudflare.mjs build` 会再核对一次）。

## Stage 3 — 合入 main，由 Workers Builds 部署

合入 `main` 就是发布。Cloudflare 控制台里 `resend-agent-mail-relay` 的 Workers Builds 收到推送后执行：

```bash
npm clean-install
npm run gate && node deploy/cloudflare.mjs build   # 构建命令
node deploy/cloudflare.mjs deploy                  # 部署命令
```

在控制台的 Deployments / Builds 页看这次构建。失败时日志里会写明是测试、配置核对还是 `wrangler deploy` 出的错；修好后重新推送到 `main`，或在控制台点 Retry build。不要在本地补一次 `wrangler deploy`，`deploy/cloudflare.mjs` 在 Workers Builds 以外会拒绝运行。

回滚也在控制台做：Deployments 里选上一版 Rollback，然后在仓库里 revert 对应提交，让下一次构建和线上一致。

## Stage 4 — 部署后核对

按 README「测试与部署后核对」逐条做。`npm run e2e` 直接打 `WORKER_URL/mcp`，而 `/mcp` 已经只接受 Service Binding，所以这个脚本现在只有 webhook 和 `/health` 的用例有意义，MCP 用例要经网关验证。
