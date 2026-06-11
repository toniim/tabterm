import { useRef, useState } from "react";
import { Archive, Compass, FolderArchive, PanelLeft, PanelRight, Plus, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.ts";
import { uuid } from "../uuid.ts";
import { sendMessage } from "../ws.ts";
import { EditableLabel } from "./EditableLabel.tsx";

// VSCode-style panel toggle: filled/accented when the panel is visible.
function PanelToggle({
  on,
  onClick,
  title,
  icon,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-7 h-7 grid place-items-center rounded-md cursor-pointer transition-colors hover:bg-[var(--hover)] ${
        on ? "text-[var(--accent)]" : "text-[var(--muted)] hover:text-[var(--text)]"
      }`}
    >
      {icon}
    </button>
  );
}

export function PrimaryTabs() {
  const primaryTabs = useStore((s) => s.primaryTabs);
  const activeId = useStore((s) => s.activePrimaryTabId);
  const setActive = useStore((s) => s.setActivePrimaryTab);
  const showSidebar = useStore((s) => s.settings.showSidebar);
  const showNotes = useStore((s) => s.settings.showNotes);
  const toggleClosedSessions = useStore((s) => s.toggleClosedSessions);
  const toggleClosedTabs = useStore((s) => s.toggleClosedTabs);
  const closedCount = useStore((s) =>
    Object.values(s.sessions).filter(
      (sess) => sess.primaryTabId === s.activePrimaryTabId && sess.closedAt != null,
    ).length,
  );
  const closedTabsCount = useStore(
    (s) => Object.values(s.primaryTabs).filter((t) => t.closedAt != null).length,
  );

  const tabs = Object.values(primaryTabs)
    .filter((t) => t.closedAt == null)
    .sort((a, b) => a.position - b.position);

  const sessionCountByTab = useStore(
    useShallow((s) => {
      const counts: Record<string, number> = {};
      for (const sess of Object.values(s.sessions)) {
        if (sess.closedAt != null) continue;
        counts[sess.primaryTabId] = (counts[sess.primaryTabId] ?? 0) + 1;
      }
      return counts;
    }),
  );

  // Tabs with at least one session waiting for attention get a dot on the pill.
  const attentionTabs = useStore(
    useShallow((s) => {
      const set: Record<string, true> = {};
      for (const sid of s.attention) {
        const sess = s.sessions[sid];
        if (sess && sess.closedAt == null) set[sess.primaryTabId] = true;
      }
      return set;
    }),
  );

  const hideTab = (id: string, label: string) => {
    const openSessions = sessionCountByTab[id] ?? 0;
    const msg = openSessions > 0
      ? `Hide "${label}"? ${openSessions} subtab shell${openSessions === 1 ? "" : "s"} will be stopped (notes + history preserved).`
      : `Hide "${label}"?`;
    if (!confirm(msg)) return;
    sendMessage({ type: "tab:close", tabId: id });
  };

  const addTab = () => {
    const label = prompt("Workspace name?");
    if (label) sendMessage({ type: "tab:create", id: uuid(), label });
  };

  // --- drag/drop reordering of the visible tabs ---
  const drag = useRef<string | null>(null);
  // `null` = nothing hovered; a tab id = insert-before that tab; "end" = append.
  const [over, setOver] = useState<string | null>(null);

  const onDragStart = (id: string) => (e: React.DragEvent) => {
    drag.current = id;
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => {
    drag.current = null;
    setOver(null);
  };
  const allowDrop = (key: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (over !== key) setOver(key);
  };
  // Drop before `beforeId` (or append when null), then send the new order.
  const drop = (beforeId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = drag.current;
    if (id) {
      const ids = tabs.map((t) => t.id).filter((x) => x !== id);
      const idx = beforeId ? ids.indexOf(beforeId) : -1;
      if (idx === -1) ids.push(id);
      else ids.splice(idx, 0, id);
      sendMessage({ type: "tab:reorder", order: ids });
    }
    onDragEnd();
  };

  return (
    <div className="flex items-center gap-1 px-3 h-12 bg-[var(--panel)] border-b border-[var(--border)] select-none">
      <span className="w-9 h-9 grid place-items-center text-[var(--accent-soft)]">
        <Compass size={18} />
      </span>
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            draggable
            onDragStart={onDragStart(t.id)}
            onDragEnd={onDragEnd}
            onDragOver={allowDrop(t.id)}
            onDrop={drop(t.id)}
            className={`group relative flex items-center h-12 max-w-[200px] border-l-2 ${
              over === t.id ? "border-[var(--accent)]" : "border-transparent"
            } ${
              active ? "text-[var(--text)]" : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            <button
              onClick={() => setActive(t.id)}
              className="pl-4 pr-1 h-12 text-sm font-medium truncate"
            >
              <EditableLabel
                value={t.label}
                onCommit={(v) =>
                  sendMessage({ type: "rename", entity: "primaryTab", id: t.id, label: v })
                }
              />
            </button>
            {attentionTabs[t.id] && (
              <span
                className="w-2 h-2 mr-1 rounded-full shrink-0 animate-pulse"
                style={{ background: "var(--orange)" }}
                title="Claude wants your attention"
              />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                hideTab(t.id, t.label);
              }}
              className="mr-2 w-5 h-5 grid place-items-center rounded text-[var(--faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--text)] hover:bg-[var(--hover)]"
              title="Hide workspace"
            >
              <X size={12} />
            </button>
            {active && (
              <span className="absolute left-3 right-3 -bottom-px h-0.5 rounded-full bg-[var(--orange)]" />
            )}
          </div>
        );
      })}
      {/* Trailing drop zone: dropping here moves a tab to the end. */}
      <div
        onDragOver={allowDrop("end")}
        onDrop={drop(null)}
        className={`self-stretch w-2 border-l-2 ${
          over === "end" ? "border-[var(--accent)]" : "border-transparent"
        }`}
      />
      <button
        onClick={addTab}
        className="w-7 h-7 grid place-items-center rounded-full border border-[var(--border-2)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent)]"
        title="New workspace"
      >
        <Plus size={15} />
      </button>

      <div className="ml-auto flex items-center gap-2.5">
        {closedTabsCount > 0 && (
          <button
            onClick={toggleClosedTabs}
            className="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
            title="Hidden workspaces"
          >
            <FolderArchive size={14} />
            <span className="mono">{closedTabsCount}</span>
          </button>
        )}
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
        <PanelToggle
          on={showSidebar}
          onClick={() => sendMessage({ type: "settings:update", patch: { showSidebar: !showSidebar } })}
          title="Toggle navigation sidebar (⌘B)"
          icon={<PanelLeft size={15} />}
        />
        <PanelToggle
          on={showNotes}
          onClick={() => sendMessage({ type: "settings:update", patch: { showNotes: !showNotes } })}
          title="Toggle notes panel"
          icon={<PanelRight size={15} />}
        />
      </div>
    </div>
  );
}
