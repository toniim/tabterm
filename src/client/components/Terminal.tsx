import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../store.ts";
import { TERM_THEMES, type TermPreset } from "../termThemes.ts";
import { TerminalKeyBar } from "./TerminalKeyBar.tsx";

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
  const fitRef = useRef<FitAddon | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const theme = useStore((s) => s.theme);
  const settings = useStore((s) => s.settings);

  // On-screen key bar — toggled from the status bar (default on for touch).
  // `sendRef` lets the bar inject raw bytes into this session's PTY; Ctrl/Alt
  // are sticky modifiers (refs drive the onData transform, state the highlight).
  const showKeyBar = useStore((s) => s.showKeyBar);
  const sendRef = useRef<(d: string) => void>(() => {});
  const ctrlArmedRef = useRef(false);
  const altArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const toggleCtrl = () => {
    const v = !ctrlArmedRef.current;
    ctrlArmedRef.current = v;
    setCtrlArmed(v);
  };
  const toggleAlt = () => {
    const v = !altArmedRef.current;
    altArmedRef.current = v;
    setAltArmed(v);
  };

  // Re-apply the xterm color theme when the app theme or preset changes.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = xtermTheme(TERM_THEMES[settings.termTheme] ?? {});
    }
  }, [theme, settings.termTheme]);

  // Live-apply font changes to the running terminal without recreating it.
  // Changing font metrics re-measures the cell box, so refit afterwards — that
  // recomputes cols/rows and fires onResize, which pushes the new size to GoTTY.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontFamily = settings.termFontFamily;
    t.options.fontSize = settings.termFontSize;
    t.options.lineHeight = settings.termLineHeight;
    try {
      fitRef.current?.fit();
    } catch {
      // host detached mid-update
    }
  }, [settings.termFontFamily, settings.termFontSize, settings.termLineHeight]);

  const focusEpoch = useStore((s) => s.focusTerminalEpoch);

  // External focus request (e.g. command palette jump). Only the mounted
  // Terminal for the active session sees this, so no sessionId check needed.
  useEffect(() => {
    if (focusEpoch === 0) return;
    requestAnimationFrame(() => termRef.current?.focus());
  }, [focusEpoch]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const s0 = useStore.getState().settings;
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: s0.termFontFamily,
      fontSize: s0.termFontSize,
      lineHeight: s0.termLineHeight,
      // With tmux mouse-on, a plain drag is captured by tmux. To still grab a
      // native browser selection (for clipboard copy) the user holds a modifier
      // that bypasses mouse reporting: Shift on Linux/Windows, Option/Alt on
      // macOS — but the macOS path only works when this option is enabled.
      macOptionClickForcesSelection: true,
      theme: xtermTheme(TERM_THEMES[s0.termTheme] ?? {}),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // xterm types into a hidden <textarea>; password managers (1Password,
    // LastPass, Bitwarden) and mobile autofill/autocorrect otherwise latch onto
    // it and pop their toolbar above the keyboard. Opt the field out — and
    // re-assert on focus, since 1Password re-scans the field when it's focused.
    const hardenInput = () => {
      const ta = host.querySelector<HTMLTextAreaElement>("textarea");
      if (!ta) return;
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("spellcheck", "false");
      ta.setAttribute("name", "tabterm-terminal-input"); // non-credential name
      ta.setAttribute("data-1p-ignore", "true"); // 1Password
      ta.setAttribute("data-lpignore", "true"); // LastPass
      ta.setAttribute("data-bwignore", "true"); // Bitwarden
      ta.setAttribute("data-form-type", "other");
      ta.setAttribute("data-protonpass-ignore", "true"); // Proton Pass
      ta.addEventListener("focus", hardenInput, { once: true });
    };
    hardenInput();

    let ws: WebSocket | null = null;
    let retries = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const enc = new TextEncoder();

    const sendRaw = (d: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    };
    sendRef.current = sendRaw; // key bar injects through here

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

    // Browser-level key remaps that xterm.js doesn't handle the way macOS terminals do.
    // Returning false suppresses xterm's own handling; preventDefault is also needed
    // because xterm uses a hidden <textarea> for IME — without it, the browser still
    // inserts the keystroke there and we'd see it a second time via onData.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Shift/Cmd/Option+Enter → LF (\n). Plain Enter sends CR (\r), which TUIs like
      // Claude Code treat as "submit"; LF is treated as "insert newline in input".
      // Ctrl+Enter is left alone so terminal apps that bind it (e.g. tmux) keep working.
      if (ev.key === "Enter" && (ev.shiftKey || ev.metaKey || ev.altKey) && !ev.ctrlKey) {
        ev.preventDefault();
        if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode("\n"));
        return false;
      }

      // Cmd+Shift+K → wipe viewport + scrollback. Plain Cmd+K is reserved for the
      // app-wide command palette; this matches iTerm2's "Clear Scrollback" chord.
      // Client-side only — the shell's screen state is untouched, so any running
      // TUI (vim, htop, claude) repaints on its next refresh.
      if (ev.key === "K" && ev.metaKey && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        term.clear();
        return false;
      }

      return true;
    });

    const onData = term.onData((d) => {
      let out = d;
      // Apply sticky Ctrl/Alt from the touch key bar to the next typed char.
      if (ctrlArmedRef.current && d.length === 1) {
        out = String.fromCharCode(d.toUpperCase().charCodeAt(0) & 0x1f);
      }
      if (altArmedRef.current) out = "\x1b" + out;
      if (ctrlArmedRef.current || altArmedRef.current) {
        ctrlArmedRef.current = false;
        altArmedRef.current = false;
        setCtrlArmed(false);
        setAltArmed(false);
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(out));
    });
    const onResize = term.onResize(sendResize);

    const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    // text/uri-list carries the real filesystem path when the OS/browser is
    // willing to share it (Finder→Chrome on a file:// origin, etc). Most http
    // origins get an empty string for security — then we upload the File blobs
    // to /api/upload and the server hands back absolute paths under a temp dir.
    const pathsFromUriList = (dt: DataTransfer): string[] => {
      const uriList = dt.getData("text/uri-list");
      if (!uriList) return [];
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
      return paths;
    };
    const uploadFiles = async (files: File[]): Promise<string[]> => {
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) return files.map((f) => f.name);
      const data = (await res.json()) as { paths?: string[] };
      return data.paths?.length ? data.paths : files.map((f) => f.name);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      // Snapshot files synchronously — dt.files becomes unreliable after await.
      const files = Array.from(e.dataTransfer.files);
      const fromUri = pathsFromUriList(e.dataTransfer);
      const paths = fromUri.length ? fromUri : files.length ? await uploadFiles(files) : [];
      if (!paths.length) return;
      const text = paths.map(shellQuote).join(" ");
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(text));
      term.focus();
    };
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    // Touch scrolling (iPad/phones): xterm.js only turns real mouse/wheel into
    // scroll, and iOS would otherwise treat a drag over the terminal as page
    // scroll. Translate a one-finger vertical swipe into app wheel events when a
    // TUI/tmux has mouse-tracking on (scrolls tmux/vim), or native xterm
    // scrollback otherwise. `touch-action: none` on the host stops the page from
    // eating the gesture.
    const TOUCH_STEP = 24; // px of swipe per scroll notch
    let touchY: number | null = null;
    let touchAccum = 0;
    const scrollByNotch = (older: boolean) => {
      if (term.modes.mouseTrackingMode !== "none") {
        // app wants mouse → send an SGR wheel event (up = 64, down = 65)
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(enc.encode(`\x1b[<${older ? 64 : 65};1;1M`));
        }
      } else {
        term.scrollLines(older ? -1 : 1); // plain shell → native scrollback
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { touchY = null; return; }
      touchY = e.touches[0].clientY;
      touchAccum = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      touchAccum += y - touchY; // finger down (Δ>0) → scroll back to older lines
      touchY = y;
      e.preventDefault();
      while (touchAccum >= TOUCH_STEP) { scrollByNotch(true); touchAccum -= TOUCH_STEP; }
      while (touchAccum <= -TOUCH_STEP) { scrollByNotch(false); touchAccum += TOUCH_STEP; }
    };
    const onTouchEnd = () => { touchY = null; };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd);
    host.addEventListener("touchcancel", onTouchEnd);

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
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      onData.dispose();
      onResize.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="relative h-full w-full flex flex-col" style={{ background: "var(--term-bg)" }}>
      <div ref={hostRef} className="flex-1 min-h-0 w-full p-2" style={{ touchAction: "none" }} />
      {showKeyBar && (
        <TerminalKeyBar
          onKey={(seq) => sendRef.current(seq)}
          ctrlArmed={ctrlArmed}
          altArmed={altArmed}
          onToggleCtrl={toggleCtrl}
          onToggleAlt={toggleAlt}
        />
      )}
      {conn !== "open" && (
        <div className={`absolute top-2 right-3 px-2 py-0.5 rounded text-xs text-white ${BADGE[conn].cls}`}>
          {BADGE[conn].text}
        </div>
      )}
    </div>
  );
}
