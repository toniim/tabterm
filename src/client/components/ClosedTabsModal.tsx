import { useEffect } from "react";
import { FolderArchive, RotateCcw, Trash2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";

function relTime(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function ClosedTabsModal() {
  const show = useStore((s) => s.showClosedTabs);
  const toggle = useStore((s) => s.toggleClosedTabs);
  const setActivePrimaryTab = useStore((s) => s.setActivePrimaryTab);
  const closed = useStore(
    useShallow((s) =>
      Object.values(s.primaryTabs)
        .filter((t) => t.closedAt != null)
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
    ),
  );

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, toggle]);

  if (!show) return null;

  const reopen = (id: string) => {
    sendMessage({ type: "tab:reopen", tabId: id });
    setActivePrimaryTab(id);
    toggle();
  };
  const purge = (id: string, label: string) => {
    if (
      !confirm(
        `Delete workspace "${label}" forever? Every subtab, note, and AI history inside will be erased.`,
      )
    ) {
      return;
    }
    sendMessage({ type: "tab:purge", tabId: id });
  };

  return (
    <div
      onClick={toggle}
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border)]">
          <FolderArchive size={15} className="text-[var(--muted)]" />
          <span className="text-sm font-semibold text-[var(--text)] flex-1">
            Hidden workspaces
          </span>
          <button
            onClick={toggle}
            className="w-7 h-7 grid place-items-center rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {closed.length === 0 && (
            <div className="text-sm text-[var(--faint)] px-3 py-6 text-center">
              No hidden workspaces.
            </div>
          )}
          {closed.map((t) => (
            <div
              key={t.id}
              className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--hover)]"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--text)] truncate">{t.label}</div>
                <div className="text-xs text-[var(--faint)] mono">
                  hidden {relTime(t.closedAt ?? 0)}
                </div>
              </div>
              <button
                onClick={() => reopen(t.id)}
                className="flex items-center gap-1 px-2 h-7 text-xs rounded-md text-[var(--accent)] hover:bg-[var(--bg)]"
                title="Reopen workspace"
              >
                <RotateCcw size={13} />
                Reopen
              </button>
              <button
                onClick={() => purge(t.id, t.label)}
                className="w-7 h-7 grid place-items-center rounded-md text-[var(--faint)] hover:text-red-400 hover:bg-[var(--bg)]"
                title="Delete forever"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
