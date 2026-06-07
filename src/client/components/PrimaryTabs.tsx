import { useState } from "react";
import { Archive, Compass, Folder, Plus } from "lucide-react";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";
import { CwdPickerModal } from "./CwdPickerModal.tsx";
import { EditableLabel } from "./EditableLabel.tsx";

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        on ? "bg-[var(--accent)]" : "bg-[var(--switch-off)]"
      }`}
      title="Toggle notes panel"
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

export function PrimaryTabs() {
  const primaryTabs = useStore((s) => s.primaryTabs);
  const activeId = useStore((s) => s.activePrimaryTabId);
  const setActive = useStore((s) => s.setActivePrimaryTab);
  const showNotes = useStore((s) => s.showNotes);
  const toggleNotes = useStore((s) => s.toggleNotes);
  const toggleClosedSessions = useStore((s) => s.toggleClosedSessions);
  const closedCount = useStore((s) =>
    Object.values(s.sessions).filter(
      (sess) => sess.primaryTabId === s.activePrimaryTabId && sess.closedAt != null,
    ).length,
  );

  const tabs = Object.values(primaryTabs).sort((a, b) => a.position - b.position);
  const activeTab = activeId ? primaryTabs[activeId] : null;
  const [pickerOpen, setPickerOpen] = useState(false);

  const addTab = () => {
    const label = prompt("Workspace name?");
    if (label) sendMessage({ type: "tab:create", id: crypto.randomUUID(), label });
  };

  return (
    <>
    <div className="flex items-center gap-1 px-3 h-12 bg-[var(--panel)] border-b border-[var(--border)] select-none">
      <span className="w-9 h-9 grid place-items-center text-[var(--accent-soft)]">
        <Compass size={18} />
      </span>
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`relative px-4 h-12 text-sm font-medium max-w-[180px] truncate ${
              active ? "text-[var(--text)]" : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            <EditableLabel
              value={t.label}
              onCommit={(v) => sendMessage({ type: "rename", entity: "primaryTab", id: t.id, label: v })}
            />
            {active && (
              <span className="absolute left-3 right-3 -bottom-px h-0.5 rounded-full bg-[var(--orange)]" />
            )}
          </button>
        );
      })}
      <button
        onClick={addTab}
        className="w-7 h-7 grid place-items-center rounded-full border border-[var(--border-2)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent)]"
        title="New workspace"
      >
        <Plus size={15} />
      </button>

      {activeTab && (
        <button
          onClick={() => setPickerOpen(true)}
          className="ml-3 flex items-center gap-1.5 px-2 h-7 rounded-md border border-[var(--border-2)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent)]"
          title="Default working directory for new subtabs in this workspace. Click to choose."
        >
          <Folder size={13} className="shrink-0" />
          <span className="mono text-xs max-w-[280px] truncate">{activeTab.cwd || "~"}</span>
        </button>
      )}

      <div className="ml-auto flex items-center gap-2.5">
        {closedCount > 0 && (
          <button
            onClick={toggleClosedSessions}
            className="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
            title="Closed subtabs in this workspace"
          >
            <Archive size={14} />
            <span className="mono">{closedCount}</span>
          </button>
        )}
        <span className="text-xs font-semibold tracking-wide text-[var(--muted)]">SHOW NOTES</span>
        <Switch on={showNotes} onClick={toggleNotes} />
      </div>
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
    </>
  );
}
