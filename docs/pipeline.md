# 质量门禁

变更按下面三段走。任一段失败，修好之后从头重跑。

本仓库是纯 JavaScript。`npm run gate` 做 `node --check`（`worker/worker.js`、`e2e/run.mjs`、`deploy/cloudflare.mjs`）、`python3 -m py_compile skill/mcp_cli.py`，然后 `node --test`。

## Stage 1 — `npm run gate`

通过条件：语法检查和全部单元测试退出码为 0。不访问 Resend，也不访问 Cloudflare。

## Stage 2 — 人工复核 diff

确认行为仍是：验签后忽略 webhook、`/mcp` 只接受 `backend.internal` 且必须带 owner、工具只有 `get_account` 和 `send_email`、`/health` 只有 `ok`。确认没有密钥，`worker/wrangler.toml` 没有 R2、队列、Workers AI、cron，D1 仍指向生产库。

## Stage 3 — 合入 main

合入 `main` 就是发布。Workers Builds 执行：

```bash
npm clean-install
npm run gate && node deploy/cloudflare.mjs build
node deploy/cloudflare.mjs deploy
```

不要在本地补一次 `wrangler deploy`。回滚在控制台选上一版，然后在仓库里 revert，让下一次构建和线上一致。

部署后核对：`GET /health` 只有 `ok`；公网 `POST /mcp` 是 404；经网关 `tools/list` 只有 `get_account`、`send_email`；一封 `send_email` 能发出且 D1 里没有新的 `emails` 行。
