export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    // Webhook 占位。后续必须校验 Svix 签名
    // （svix-id / svix-timestamp / svix-signature）对照 WEBHOOK_SECRET，
    // 未通过不得处理 payload。
    if (request.method === "POST" && pathname === "/") {
      return new Response(null, { status: 200 });
    }

    // MCP 占位，协议与鉴权尚未实现。
    if (request.method === "POST" && pathname === "/mcp") {
      return new Response(null, { status: 501 });
    }

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  },
};
