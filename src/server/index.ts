import type { ServerWebSocket, WebSocketHandler } from "bun";
import { join } from "node:path";
import * as ai from "./ai.ts";
import { seedIfEmpty } from "./db.ts";
import { killAll, respawnAll } from "./gotty.ts";
import * as proxy from "./proxy.ts";
import { handleApi } from "./routes.ts";
import * as appws from "./ws.ts";

const PORT = Number(process.env.PORT ?? 3000);
const isProd = process.env.NODE_ENV === "production";
const DIST = join(import.meta.dir, "../../dist");

type AppData = { kind: "app" };
type SocketData = AppData | proxy.ProxyData;

seedIfEmpty();
await respawnAll(); // auto-respawn GoTTY for persisted sessions on restart

const asProxy = (ws: ServerWebSocket<SocketData>) => ws as ServerWebSocket<proxy.ProxyData>;
const asApp = (ws: ServerWebSocket<SocketData>) => ws as ServerWebSocket<unknown>;

const websocket: WebSocketHandler<SocketData> = {
  async open(ws) {
    if (ws.data.kind === "gotty") await proxy.onOpen(asProxy(ws));
    else appws.onOpen(asApp(ws));
  },
  message(ws, message) {
    if (ws.data.kind === "gotty") {
      proxy.onMessage(asProxy(ws), message);
    } else {
      appws.onMessage(asApp(ws), typeof message === "string" ? message : message.toString());
    }
  },
  close(ws) {
    if (ws.data.kind === "gotty") proxy.onClose(asProxy(ws));
    else appws.onClose(asApp(ws));
  },
};

const server = Bun.serve({
  port: PORT,
  websocket,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Per-session PTY proxy WS: /gotty/ws/:sessionId
    if (url.pathname.startsWith("/gotty/ws/")) {
      const sessionId = url.pathname.slice("/gotty/ws/".length);
      if (server.upgrade(req, { data: { kind: "gotty", sessionId, queue: [] } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // App-level state WS
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { kind: "app" } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/api/ai/chat" && req.method === "POST") return ai.handleChat(req);
    if (url.pathname === "/api/ai/history") return ai.handleHistory(url);

    const api = url.pathname.startsWith("/api/") ? handleApi(url) : null;
    if (api) return api;

    if (isProd) {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(DIST, path));
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(DIST, "index.html")));
    }

    return new Response("Not found", { status: 404 });
  },
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killAll();
    process.exit(0);
  });
}

console.log(`[tabterm] server listening on http://localhost:${server.port} (${isProd ? "prod" : "dev"})`);
