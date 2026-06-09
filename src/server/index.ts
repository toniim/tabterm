import type { ServerWebSocket, WebSocketHandler } from "bun";
import { join } from "node:path";
import { config } from "./config.ts";
import { seedIfEmpty } from "./db.ts";
import { getSpaFile, hasEmbeddedSpa } from "./embedded.ts";
import { killAll, reapOrphans, respawnAll, startHealthMonitor } from "./gotty.ts";
import * as proxy from "./proxy.ts";
import { handleApi, handleUpload } from "./routes.ts";
import * as appws from "./ws.ts";

const PORT = config.port;
// `bun build --compile` inlines `process.env.NODE_ENV` at build time, so a
// runtime NODE_ENV=production has no effect on the compiled binary. Treat any
// compiled run as prod — there's no Vite to serve the SPA in that mode.
const COMPILED = import.meta.dir.startsWith("/$bunfs/");
const isProd = COMPILED || process.env.NODE_ENV === "production";
// In dev/prod-from-source we read built assets off disk from <repo>/dist. The
// compiled binary serves them straight out of its embedded bunfs instead.
const DIST = join(import.meta.dir, "../..", "dist");

type AppData = { kind: "app" };
type SocketData = AppData | proxy.ProxyData;

seedIfEmpty();
reapOrphans(); // kill any gotty children left behind by a previous crash
await respawnAll(); // auto-respawn GoTTY for persisted sessions on restart
startHealthMonitor(); // ping GoTTY processes every 30s, respawn if unresponsive

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
      if (server.upgrade(req, { data: { kind: "gotty", sessionId } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // App-level state WS
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { kind: "app" } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/api/upload" && req.method === "POST") return handleUpload(req);

    const api = url.pathname.startsWith("/api/") ? handleApi(url) : null;
    if (api) return api;

    if (isProd) {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      if (hasEmbeddedSpa()) {
        const file = getSpaFile(path) ?? getSpaFile("/index.html");
        return new Response(file!);
      }
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
