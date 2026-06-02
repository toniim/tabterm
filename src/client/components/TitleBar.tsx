import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";
import { EditableLabel } from "./EditableLabel.tsx";

const STATUS_LABEL = {
  connecting: "connecting…",
  open: "live",
  closed: "reconnecting…",
} as const;

const STATUS_COLOR = {
  connecting: "#f59e0b",
  open: "#22c55e",
  closed: "#ef4444",
} as const;

export function TitleBar() {
  const primaryTabs = useStore((s) => s.primaryTabs);
  const activeId = useStore((s) => s.activePrimaryTabId);
  const status = useStore((s) => s.status);
  const setActive = useStore((s) => s.setActivePrimaryTab);

  const tabs = Object.values(primaryTabs).sort((a, b) => a.position - b.position);

  return (
    <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3 h-10 select-none">
      <span className="font-semibold text-sm mr-3 text-gray-300">TabTerm</span>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setActive(t.id)}
          className={`px-3 py-1 rounded text-sm ${
            t.id === activeId
              ? "bg-[var(--color-bg)] text-white"
              : "text-gray-400 hover:text-gray-200"
          }`}
          title="Double-click to rename"
        >
          <EditableLabel
            value={t.label}
            onCommit={(v) => sendMessage({ type: "rename", entity: "primaryTab", id: t.id, label: v })}
          />
        </button>
      ))}
      <div className="ml-auto flex items-center gap-2 text-xs text-gray-400">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: STATUS_COLOR[status] }}
        />
        {STATUS_LABEL[status]}
      </div>
    </div>
  );
}
