import type { ServerWebSocket } from "bun";
import { ensure, portOf } from "./gotty.ts";

// Per-browser-connection proxy state. Each browser WS maps to its own upstream
// WS to the session's GoTTY (and thus its own forked shell).
export interface ProxyData {
  kind: "gotty";
  sessionId: string;
  upstream?: WebSocket;
  queue: string[]; // GoTTY-framed frames buffered until upstream is open
}

const td = new TextDecoder();

function toGottyFrame(browserMsg: string | Buffer): string | null {
  // Browser → proxy contract:
  //   string  = resize JSON {cols, rows}
  //   binary  = raw keystroke bytes
  if (typeof browserMsg === "string") {
    try {
      const { cols, rows } = JSON.parse(browserMsg) as { cols: number; rows: number };
      return "3" + JSON.stringify({ columns: cols, rows: rows });
    } catch {
      return null;
    }
  }
  return "1" + td.decode(browserMsg); // GoTTY Input
}

export async function onOpen(ws: ServerWebSocket<ProxyData>): Promise<void> {
  const { sessionId } = ws.data;
  const port = portOf(sessionId) ?? (await ensure(sessionId));

  const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.data.upstream = upstream;

  upstream.onopen = () => {
    // GoTTY requires an init frame before it starts the shell.
    upstream.send(JSON.stringify({ AuthToken: "", Arguments: "" }));
    for (const frame of ws.data.queue) upstream.send(frame);
    ws.data.queue = [];
  };

  upstream.onmessage = (ev) => {
    const data = typeof ev.data === "string" ? ev.data : td.decode(ev.data as ArrayBuffer);
    const type = data[0];
    if (type === "1") {
      // GoTTY Output: base64-encoded PTY bytes → raw binary to the browser.
      const bytes = Uint8Array.fromBase64
        ? Uint8Array.fromBase64(data.slice(1))
        : Buffer.from(data.slice(1), "base64");
      ws.send(bytes);
    }
    // other types (title/pong/prefs) are not needed by xterm.js
  };

  upstream.onclose = () => ws.close();
  upstream.onerror = () => ws.close();
}

export function onMessage(ws: ServerWebSocket<ProxyData>, message: string | Buffer): void {
  const frame = toGottyFrame(message);
  if (frame === null) return;
  const upstream = ws.data.upstream;
  if (upstream && upstream.readyState === WebSocket.OPEN) {
    upstream.send(frame);
  } else {
    ws.data.queue.push(frame);
  }
}

export function onClose(ws: ServerWebSocket<ProxyData>): void {
  ws.data.upstream?.close();
}
