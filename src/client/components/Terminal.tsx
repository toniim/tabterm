import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const MAX_RETRIES = 5;

export function Terminal({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: { background: "#0f1115", foreground: "#e5e7eb" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let ws: WebSocket | null = null;
    let retries = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const enc = new TextEncoder();

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
      }
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/gotty/ws/${sessionId}`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        retries = 0;
        sendResize();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") return; // control frames, ignored
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (closed) return;
        if (retries >= MAX_RETRIES) {
          term.write("\r\n\x1b[31m[disconnected — reload to reconnect]\x1b[0m\r\n");
          return;
        }
        const delay = Math.min(5000, 250 * 2 ** retries);
        retries += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    const onData = term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });
    const onResize = term.onResize(sendResize);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // host detached mid-resize
      }
    });
    ro.observe(host);

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="h-full w-full" />;
}
