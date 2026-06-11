import { useRef, useState } from "react";
import { FolderPlus, FolderTree, PanelLeftClose, Plus, X } from "lucide-react";
import type { GroupColor, SessionKind } from "../../shared/types.ts";
import { GROUP_COLORS } from "../../shared/types.ts";
import { buildTree, intoGroup, toTop, type Tree } from "../layout.ts";
import { useStore } from "../store.ts";
import { uuid } from "../uuid.ts";
import { sendMessage } from "../ws.ts";
import { ensureNotifyPermission } from "../notifications.ts";
import { EditableLabel } from "./EditableLabel.tsx";

const COLOR_HEX: Record<GroupColor, string> = {
  slate: "#94a3b8",
  red: "#ef4444",
  amber: "#f59e0b",
  green: "#22c55e",
  cyan: "#06b6d4",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
};

type Drag = { kind: "group" | "session"; id: string };

export function Sidebar() {
  const primaryTabId = useStore((s) => s.activePrimaryTabId);
  const groups = useStore((s) => s.groups);
  const sessions = useStore((s) => s.sessions);
  const order = useStore((s) => s.order);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const attention = useStore((s) => s.attention);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const requestFocus = useStore((s) => s.requestFocus);
  const sessionCommands = useStore((s) => s.sessionCommands);
  // Sidebar visibility is server-persisted (synced settings), toggled over WS.
  const hideSidebar = () => sendMessage({ type: "settings:update", patch: { showSidebar: false } });

  const drag = useRef<Drag | null>(null);
  const grpTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [over, setOver] = useState<string | null>(null);

  if (!primaryTabId) {
    return <aside className="w-64 border-r border-[var(--border)] bg-[var(--panel)]" />;
  }

  const tabId = primaryTabId;
  const tree = buildTree(order[tabId] ?? [], groups, sessions);

  const isOpen = (sid: string) => sessions[sid] && sessions[sid].closedAt == null;

  // running number across the flattened visual order (skipping closed sessions
  // so the index matches what's actually rendered).
  const numberOf: Record<string, number> = {};
  let n = 0;
  for (const ref of tree.top) {
    if (groups[ref]) {
      for (const sid of tree.groups[ref] ?? []) if (isOpen(sid)) numberOf[sid] = ++n;
    } else if (isOpen(ref)) {
      numberOf[ref] = ++n;
    }
  }

  const sendLayout = (t: Tree) =>
    sendMessage({ type: "layout", primaryTabId: tabId, order: t.top, groups: t.groups });

  const addGroup = () => {
    const label = prompt("Group name?");
    if (!label) return;
    const color = GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
    sendMessage({ type: "group:create", primaryTabId: tabId, label, color });
  };
  const addSession = (groupId?: string, kind: SessionKind = "shell") => {
    const count = Object.values(sessions).filter((s) => s.primaryTabId === tabId).length;
    const cmd = sessionCommands.find((c) => c.type === kind);
    const prefix = cmd ? cmd.label.split(" ")[0] : "Session";
    const label = `${prefix} ${count + 1}`;
    const id = uuid();
    requestFocus(id);
    sendMessage({ type: "session:create", id, primaryTabId: tabId, groupId, label, kind });
  };
  const rename = (entity: "group" | "session", id: string, label: string) =>
    sendMessage({ type: "rename", entity, id, label });

  // --- drag/drop ---
  const onDragStart = (kind: Drag["kind"], id: string) => (e: React.DragEvent) => {
    drag.current = { kind, id };
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => {
    drag.current = null;
    setOver(null);
  };
  // `stop` is set for rows nested inside a group: without it the dragover
  // bubbles to the group wrapper's own onDragOver, which overwrites `over` and
  // suppresses the per-row insertion bar, making in-group reordering unusable.
  const allowDrop = (key: string, stop = false) => (e: React.DragEvent) => {
    e.preventDefault();
    if (stop) e.stopPropagation();
    if (over !== key) setOver(key);
  };
  const dropTop = (beforeId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag.current;
    if (d) sendLayout(toTop(tree, d.id, beforeId));
    onDragEnd();
  };
  const dropGroup = (gid: string, beforeSid: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag.current;
    if (d?.kind === "session") sendLayout(intoGroup(tree, d.id, gid, beforeSid));
    else if (d?.kind === "group") sendLayout(toTop(tree, d.id, gid));
    onDragEnd();
  };
  const insertBar = (key: string) =>
    over === key ? "border-t-2 border-[var(--accent)]" : "border-t-2 border-transparent";

  const SessionRow = ({
    id,
    dot,
    onDrop,
    overKey,
  }: {
    id: string;
    dot?: string;
    onDrop: (e: React.DragEvent) => void;
    overKey: string;
  }) => {
    const s = sessions[id];
    if (!s) return null;
    const active = id === activeSessionId;
    return (
      <div
        draggable
        onDragStart={onDragStart("session", id)}
        onDragEnd={onDragEnd}
        onDragOver={allowDrop(overKey, true)}
        onDrop={onDrop}
        onClick={() => {
          ensureNotifyPermission();
          setActiveSession(id);
        }}
        className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm ${insertBar(
          overKey,
        )} ${
          active
            ? "bg-[var(--panel)] border border-[var(--border-2)] text-[var(--text)] font-medium shadow-sm"
            : "border border-transparent text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        }`}
      >
        <span className="mono text-xs text-[var(--faint)] w-4 shrink-0">{numberOf[id]}.</span>
        {dot && (
          <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
        )}
        <EditableLabel
          value={s.label}
          onCommit={(v) => rename("session", id, v)}
          className={`truncate flex-1 ${s.status === "running" ? "" : "italic opacity-60"}`}
        />
        {attention.has(id) && (
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0 animate-pulse"
            style={{ background: "var(--orange)" }}
            title="Claude wants your attention"
          />
        )}
        <button
          className="opacity-0 group-hover:opacity-100 text-[var(--faint)] hover:text-red-400"
          onClick={(e) => {
            e.stopPropagation();
            sendMessage({ type: "session:close", sessionId: id });
          }}
          title="Close subtab (kept in Archive)"
        >
          <X size={13} />
        </button>
      </div>
    );
  };

  return (
    <aside className="w-64 shrink-0 border-r border-[var(--border)] bg-[var(--panel)] flex flex-col">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border)]">
        <FolderTree size={15} className="text-[var(--muted)]" />
        <span className="text-xs font-semibold tracking-wide text-[var(--muted)] flex-1">NESTED TABS</span>
        <button onClick={addGroup} className="text-[var(--muted)] hover:text-[var(--text)]" title="New group">
          <FolderPlus size={16} />
        </button>
        <button onClick={hideSidebar} className="text-[var(--muted)] hover:text-[var(--text)]" title="Hide sidebar (⌘B)">
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {tree.top.map((ref) => {
          const group = groups[ref];
          if (group) {
            const children = tree.groups[group.id] ?? [];
            const overGroup = over === `g:${group.id}`;
            return (
              <div
                key={group.id}
                className={overGroup ? "rounded-lg ring-1 ring-[var(--accent)]/60" : ""}
                onDragOver={allowDrop(`g:${group.id}`)}
                onDrop={dropGroup(group.id, null)}
              >
                <div
                  draggable
                  onDragStart={onDragStart("group", group.id)}
                  onDragEnd={onDragEnd}
                  // single-click toggles (debounced so a double-click, which
                  // fires two clicks first, cancels it and edits instead)
                  onClick={() => {
                    clearTimeout(grpTimer.current);
                    const gid = group.id;
                    grpTimer.current = setTimeout(() => sendMessage({ type: "group:toggle", groupId: gid }), 200);
                  }}
                  onDoubleClick={() => clearTimeout(grpTimer.current)}
                  className={`flex items-center gap-1.5 px-2 py-1.5 text-xs uppercase tracking-wide text-[var(--faint)] cursor-pointer hover:text-[var(--muted)] ${insertBar(
                    `top:${group.id}`,
                  )}`}
                >
                  <span className="w-4 text-center">{group.isOpen ? "▾" : "▸"}</span>
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: COLOR_HEX[group.color] }} />
                  <EditableLabel value={group.label} onCommit={(v) => rename("group", group.id, v)} className="flex-1 truncate" bubble />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      addSession(group.id);
                    }}
                    className="hover:text-[var(--text)]"
                    title="New subtab in group"
                  >
                    <Plus size={13} />
                  </button>
                </div>
                {group.isOpen &&
                  children
                    .filter((sid) => isOpen(sid))
                    .map((sid) => (
                      <div key={sid} className="ml-2">
                        <SessionRow id={sid} dot={COLOR_HEX[group.color]} overKey={`c:${sid}`} onDrop={dropGroup(group.id, sid)} />
                      </div>
                    ))}
              </div>
            );
          }
          if (!isOpen(ref)) return null;
          return <SessionRow key={ref} id={ref} overKey={`top:${ref}`} onDrop={dropTop(ref)} />;
        })}

        <div
          onDragOver={allowDrop("bottom")}
          onDrop={dropTop(null)}
          className={`h-8 mt-1 rounded-lg ${over === "bottom" ? "ring-1 ring-[var(--accent)]/50 bg-[var(--accent)]/5" : ""}`}
        />
      </div>

      <div className="border-t border-[var(--border)] p-3 space-y-2">
        <button
          onClick={() => addSession()}
          className="w-full flex items-center justify-center gap-2 text-sm py-2 rounded-lg border border-[var(--border-2)] text-[var(--text)] hover:bg-[var(--hover)]"
        >
          <Plus size={15} /> Session
        </button>
        {sessionCommands.map((cmd) => (
          <button
            key={cmd.type}
            onClick={() => addSession(undefined, cmd.type)}
            className="w-full flex items-center justify-center gap-2 text-sm py-2 rounded-lg border border-[var(--border-2)] text-[var(--text)] hover:bg-[var(--hover)]"
            title={`Launch ${cmd.command}`}
          >
            <span style={{ color: cmd.color ?? "var(--muted)" }}>{cmd.icon}</span> {cmd.label}
          </button>
        ))}
      </div>
    </aside>
  );
}
