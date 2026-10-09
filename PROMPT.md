# 不要再按旧说明安装邮件存档

这个分支删掉了邮件存储。不要创建 R2 桶、入队队列、Workers AI，也不要执行以前的 `docs/install.md` 把 webhook 接到存档消费者上。

如果任务是部署当前代码：只保留 Worker、已有的 D1（里面的 `rate_limits`）、`WEBHOOK_SECRET` 和 `RESEND_API_KEY`。`GET /health` 只能是 `{"ok":true}`。`tools/list` 只能是 `get_account` 和 `send_email`。不要发明读信工具。

历史邮件还在原来的 D1 和 R2 里。这个任务不删除它们。
