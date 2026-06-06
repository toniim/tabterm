import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { registerScrollback } from "../terminals.ts";
import { useStore } from "../store.ts";
import { TERM_THEMES, type TermPreset } from "../termThemes.ts";

const MAX_RETRIES = 5;

type ConnState = "connecting" | "open" | "reconnecting" | "failed";

const BADGE: Record<Exclude<ConnState, "open">, { text: string; cls: string }> = {
  connecting: { text: "connecting…", cls: "bg-amber-500/80" },
  reconnecting: { text: "reconnecting…", cls: "bg-amber-500/80" },
  failed: { text: "disconnected — reload", cls: "bg-red-600/80" },
};

function xtermTheme(preset: TermPreset): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const bg = v("--term-bg", "#0a0d12");
  const fg = preset.foreground ?? v("--term-fg", "#d7dbe2");
  return {
    background: bg,
    foreground: fg,
    cursor: preset.cursor ?? fg,
    cursorAccent: bg,
    selectionBackground: "rgba(59,130,246,0.35)",
  };
}

export function Terminal({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const theme = useStore((s) => s.theme);
  const termTheme = useStore((s) => s.termTheme);

  // Re-apply the xterm color theme when the app theme or preset changes.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(TERM_THEMES[termTheme] ?? {});
  }, [theme, termTheme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: xtermTheme(TERM_THEMES[useStore.getState().termTheme] ?? {}),
    });
    termRef.current = term;
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
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/gotty/ws/${sessionId}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        retries = 0;
        setConn("open");
        sendResize();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") return;
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (closed) return;
        if (retries >= MAX_RETRIES) {
          setConn("failed");
          term.write("\r\n\x1b[31m[disconnected — reload to reconnect]\x1b[0m\r\n");
          return;
        }
        setConn("reconnecting");
        const delay = Math.min(5000, 250 * 2 ** retries);
        retries += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    // Shift+Enter → ESC+CR, the sequence Claude Code recognizes as a newline-in-input
    // (matches what `claude /terminal-setup` configures iTerm2 to send).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode("\x1b\r"));
        return false;
      }
      return true;
    });

    const onData = term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });
    const onResize = term.onResize(sendResize);

    const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const pathsFromDrop = (dt: DataTransfer): string[] => {
      const uriList = dt.getData("text/uri-list");
      if (uriList) {
        const paths: string[] = [];
        for (const line of uriList.split(/\r?\n/)) {
          const t = line.trim();
          if (!t || t.startsWith("#")) continue;
          if (t.startsWith("file://")) {
            try {
              paths.push(decodeURIComponent(new URL(t).pathname));
            } catch {
              // skip malformed
            }
          }
        }
        if (paths.length) return paths;
      }
      return Array.from(dt.files).map((f) => f.name);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      const paths = pathsFromDrop(e.dataTransfer);
      if (!paths.length) return;
      const text = paths.map(shellQuote).join(" ");
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(text));
      term.focus();
    };
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    const unregister = registerScrollback(sessionId, () => {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      return lines.filter((l) => l.trim() !== "");
    });

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
      unregister();
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      onData.dispose();
      onResize.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="relative h-full w-full" style={{ background: "var(--term-bg)" }}>
      <div ref={hostRef} className="h-full w-full p-2" />
      {conn !== "open" && (
        <div className={`absolute top-2 right-3 px-2 py-0.5 rounded text-xs text-white ${BADGE[conn].cls}`}>
          {BADGE[conn].text}
        </div>
      )}
    </div>
  );
}
