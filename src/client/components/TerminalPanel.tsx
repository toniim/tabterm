import { useState } from "react";
import { ChevronRight, Folder } from "lucide-react";
import type { Session } from "../../shared/types.ts";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";
import { CwdPickerModal } from "./CwdPickerModal.tsx";
import { EditableLabel } from "./EditableLabel.tsx";
import { Terminal } from "./Terminal.tsx";

export function TerminalPanel({ session }: { session: Session }) {
  const online = useStore((s) => s.status === "open");
  const activeTab = useStore((s) => s.primaryTabs[session.primaryTabId]);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="flex-1 min-w-0 m-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--border)] shrink-0">
        <ChevronRight size={15} className="text-[var(--accent-soft)] shrink-0" />
        <span
          className="mono text-xs font-semibold tracking-wider uppercase text-[var(--accent-soft)] truncate flex items-center gap-1.5 min-w-0"
          title="Double-click the name to rename this session"
        >
          <EditableLabel
            value={session.label}
            onCommit={(v) => sendMessage({ type: "rename", entity: "session", id: session.id, label: v })}
            className="truncate cursor-text"
          />
        </span>
        {activeTab && (
          <button
            onClick={() => setPickerOpen(true)}
            className="ml-2 flex items-center gap-1.5 px-2 h-7 rounded-md border border-[var(--border-2)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent)]"
            title="Default working directory for new subtabs in this workspace. Click to choose."
          >
            <Folder size={13} className="shrink-0" />
            <span className="mono text-xs max-w-[280px] truncate">{activeTab.cwd || "~"}</span>
          </button>
        )}
        <div className="ml-auto flex items-center gap-3 mono text-[11px]">
          <span style={{ color: online ? "var(--green)" : "var(--orange)" }} className="font-semibold tracking-wide">
            {online ? "READY" : "OFFLINE"}
          </span>
          <span className="text-[var(--accent-soft)]/80">guest@sandbox</span>
        </div>
      </div>

      <div className="flex-1 min-h-0" style={{ background: "var(--term-bg)" }}>
        <Terminal key={session.id} sessionId={session.id} />
      </div>

      {pickerOpen && activeTab && (
        <CwdPickerModal
          initial={activeTab.cwd}
          onClose={() => setPickerOpen(false)}
          onSelect={(path) => {
            sendMessage({ type: "tab:setCwd", tabId: activeTab.id, cwd: path });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
