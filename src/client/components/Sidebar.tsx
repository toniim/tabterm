import { useRef, useState } from "react";
import type { GroupColor } from "../../shared/types.ts";
import { GROUP_COLORS } from "../../shared/types.ts";
import { buildTree, intoGroup, toTop, type Tree } from "../layout.ts";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";
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
  const setActiveSession = useStore((s) => s.setActiveSession);

  const drag = useRef<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);

  if (!primaryTabId) {
    return <aside className="w-60 border-r border-[var(--color-border)] bg-[var(--color-panel)]" />;
  }

  const tabId = primaryTabId;
  const tree = buildTree(order[tabId] ?? [], groups, sessions);

  const sendLayout = (t: Tree) =>
    sendMessage({ type: "layout", primaryTabId: tabId, order: t.top, groups: t.groups });

  // --- mutations ---
  const addGroup = () => {
    const label = prompt("Group name?");
    if (!label) return;
    const color = GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
    sendMessage({ type: "group:create", primaryTabId: tabId, label, color });
  };
  const addSession = (groupId?: string) => {
    const label = prompt("Session name?");
    if (!label) return;
    sendMessage({ type: "session:create", primaryTabId: tabId, groupId, label });
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
  const allowDrop = (key: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (over !== key) setOver(key);
  };
  // Drop at top level, before `beforeId` (null = append). Works for groups and
  // sessions (a session dropped here becomes ungrouped).
  const dropTop = (beforeId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag.current;
    if (d) sendLayout(toTop(tree, d.id, beforeId));
    onDragEnd();
  };
  // Drop into a group. A session moves in (before `beforeSid`, or appended);
  // a group dropped here is reordered before the target group instead.
  const dropGroup = (gid: string, beforeSid: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag.current;
    if (d?.kind === "session") sendLayout(intoGroup(tree, d.id, gid, beforeSid));
    else if (d?.kind === "group") sendLayout(toTop(tree, d.id, gid));
    onDragEnd();
  };

  const insertBar = (key: string) =>
    over === key ? "border-t-2 border-blue-400" : "border-t-2 border-transparent";

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
    return (
      <div
        draggable
        onDragStart={onDragStart("session", id)}
        onDragEnd={onDragEnd}
        onDragOver={allowDrop(overKey)}
        onDrop={onDrop}
        className={`group flex items-center gap-2 pl-2 pr-1 py-1 rounded cursor-pointer text-sm ${insertBar(
          overKey,
        )} ${
          id === activeSessionId
            ? "bg-[var(--color-bg)] text-white"
            : "text-gray-300 hover:bg-[var(--color-bg)]/50"
        }`}
        onClick={() => setActiveSession(id)}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: dot ?? "#4b5563" }}
        />
        <EditableLabel
          value={s.label}
          onCommit={(v) => rename("session", id, v)}
          className="truncate flex-1"
        />
        <button
          className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 px-1"
          onClick={(e) => {
            e.stopPropagation();
            sendMessage({ type: "session:delete", sessionId: id });
          }}
          title="Delete session"
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <aside className="w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-panel)] flex flex-col">
      <div className="flex-1 overflow-y-auto p-2">
        {tree.top.map((ref) => {
          const group = groups[ref];
          if (group) {
            const children = tree.groups[group.id] ?? [];
            const overGroup = over === `g:${group.id}`;
            return (
              <div
                key={group.id}
                className={overGroup ? "rounded ring-1 ring-blue-400/70" : ""}
                onDragOver={allowDrop(`g:${group.id}`)}
                onDrop={dropGroup(group.id, null)}
              >
                <div
                  draggable
                  onDragStart={onDragStart("group", group.id)}
                  onDragEnd={onDragEnd}
                  className={`flex items-center gap-1.5 px-1 py-1 text-xs uppercase tracking-wide text-gray-400 ${insertBar(
                    `top:${group.id}`,
                  )}`}
                >
                  <button
                    onClick={() => sendMessage({ type: "group:toggle", groupId: group.id })}
                    className="w-4 text-gray-500 hover:text-gray-200"
                    title={group.isOpen ? "Collapse" : "Expand"}
                  >
                    {group.isOpen ? "▾" : "▸"}
                  </button>
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: COLOR_HEX[group.color] }}
                  />
                  <EditableLabel
                    value={group.label}
                    onCommit={(v) => rename("group", group.id, v)}
                    className="flex-1 truncate"
                  />
                  <button
                    onClick={() => addSession(group.id)}
                    className="text-gray-500 hover:text-gray-200 px-1"
                    title="New session in group"
                  >
                    +
                  </button>
                </div>
                {group.isOpen &&
                  children.map((sid) => (
                    <div key={sid} className="ml-3">
                      <SessionRow
                        id={sid}
                        dot={COLOR_HEX[group.color]}
                        overKey={`c:${sid}`}
                        onDrop={dropGroup(group.id, sid)}
                      />
                    </div>
                  ))}
              </div>
            );
          }
          // ungrouped session
          return (
            <SessionRow
              key={ref}
              id={ref}
              overKey={`top:${ref}`}
              onDrop={dropTop(ref)}
            />
          );
        })}

        {/* trailing drop zone: append to top level / ungroup */}
        <div
          onDragOver={allowDrop("bottom")}
          onDrop={dropTop(null)}
          className={`h-8 mt-1 rounded ${over === "bottom" ? "bg-blue-400/10 ring-1 ring-blue-400/50" : ""}`}
        />
      </div>

      <div className="border-t border-[var(--color-border)] p-2 flex gap-2">
        <button
          onClick={() => addSession()}
          className="flex-1 text-xs py-1.5 rounded bg-[var(--color-bg)] text-gray-300 hover:text-white"
        >
          + Session
        </button>
        <button
          onClick={addGroup}
          className="flex-1 text-xs py-1.5 rounded bg-[var(--color-bg)] text-gray-300 hover:text-white"
        >
          + Group
        </button>
      </div>
    </aside>
  );
}
