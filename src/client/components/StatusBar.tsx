import { Download, Moon, RefreshCw, Sun, Upload } from "lucide-react";
import { useStore } from "../store.ts";
import { TerminalSettingsPopover } from "./TerminalSettingsPopover.tsx";

const iconBtn =
  "w-6 h-6 grid place-items-center rounded text-[var(--statusbar-fg)] hover:bg-[var(--statusbar-chip)] transition-colors";

function Dot() {
  return <span className="opacity-50">•</span>;
}

export function StatusBar() {
  const status = useStore((s) => s.status);
  const tab = useStore((s) => (s.activePrimaryTabId ? s.primaryTabs[s.activePrimaryTabId] : null));
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : null));
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const port = location.port || "3000";

  return (
    <footer
      className="flex items-center gap-2.5 px-4 h-7 text-[11px] mono shrink-0"
      style={{ background: "var(--statusbar)", color: "var(--statusbar-fg)" }}
    >
      <span className="font-semibold tracking-wide">{status === "open" ? "READY" : status.toUpperCase()}</span>
      <Dot />
      <span>main*</span>
      <Dot />
      <span>Node Dev Server: {port}</span>
      <Dot />
      <span className="truncate">
        Active: {tab?.label ?? "—"}
        {session ? ` › ${session.label}` : ""}
      </span>
      <div className="ml-auto flex items-center gap-2.5">
        <span
          className="px-1.5 py-0.5 rounded font-semibold tracking-wide"
          style={{ background: "var(--statusbar-chip)" }}
        >
          STATE PERSISTED
        </span>
        <span>UTF-8</span>
        <Dot />
        <TerminalSettingsPopover />
        <div className="flex items-center gap-0.5">
          <button onClick={toggleTheme} className={iconBtn} title="Toggle theme">
            {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
          </button>
          <button
            className={iconBtn}
            title="Copy workspace link"
            onClick={() => navigator.clipboard?.writeText(location.href)}
          >
            <Upload size={12} />
          </button>
          <button className={iconBtn} title="Export state" onClick={() => exportState()}>
            <Download size={12} />
          </button>
          <button className={iconBtn} title="Reconnect" onClick={() => location.reload()}>
            <RefreshCw size={12} />
          </button>
        </div>
      </div>
    </footer>
  );
}

async function exportState() {
  const data = await (await fetch("/api/state")).text();
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "tabterm-state.json";
  a.click();
  URL.revokeObjectURL(url);
}
