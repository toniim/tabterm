import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Layers, Pencil, Plus, Search, TerminalSquare } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { PrimaryTab, Session, SessionCommand, SessionKind } from "../../shared/types.ts";
import { useStore } from "../store.ts";
import { uuid } from "../uuid.ts";
import { sendMessage } from "../ws.ts";

type Entry =
  | {
      kind: "session";
      id: string;
      label: string;
      session: Session;
      workspaceLabel: string;
      inActive: boolean;
      // True only for entries rendered in the top "Needs attention" section.
      // Used to key React rows and to drive the section header.
      inAttention?: boolean;
      hasAttention: boolean;
    }
  | { kind: "primaryTab"; id: string; label: string; tab: PrimaryTab }
  | {
      kind: "action";
      id: string;
      label: string;
      run: () => void;
      icon: "plus-shell" | "archive-sessions" | "archive-tabs" | "rename-session";
      // When true, activating keeps the palette open (the action drives an
      // inline follow-up like the rename prompt instead of closing).
      keepOpen?: boolean;
    }
  | { kind: "action-launch"; id: string; label: string; run: () => void; cmd: SessionCommand };

function iconFor(entry: Entry, commandsByKind: Record<string, SessionCommand>) {
  if (entry.kind === "session") {
    const cmd = commandsByKind[entry.session.kind];
    if (cmd) return <span style={{ color: cmd.color ?? "var(--muted)" }}>{cmd.icon}</span>;
    return <TerminalSquare size={14} className="text-[var(--muted)]" />;
  }
  if (entry.kind === "primaryTab") return <Layers size={14} className="text-[var(--muted)]" />;
  if (entry.kind === "action-launch") {
    return <span style={{ color: entry.cmd.color ?? "var(--muted)" }}>{entry.cmd.icon}</span>;
  }
  if (entry.icon === "plus-shell") return <Plus size={14} className="text-[var(--muted)]" />;
  if (entry.icon === "rename-session") return <Pencil size={14} className="text-[var(--muted)]" />;
  return <Archive size={14} className="text-[var(--muted)]" />;
}

export function CommandPalette() {
  const show = useStore((s) => s.showCommandPalette);
  const toggle = useStore((s) => s.toggleCommandPalette);
  const activePrimaryTabId = useStore((s) => s.activePrimaryTabId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActivePrimaryTab = useStore((s) => s.setActivePrimaryTab);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const requestFocus = useStore((s) => s.requestFocus);
  const focusActiveTerminal = useStore((s) => s.focusActiveTerminal);
  const toggleClosedSessions = useStore((s) => s.toggleClosedSessions);
  const toggleClosedTabs = useStore((s) => s.toggleClosedTabs);

  const primaryTabs = useStore(useShallow((s) => s.primaryTabs));
  const sessions = useStore(useShallow((s) => s.sessions));
  const order = useStore(useShallow((s) => s.order));
  const sessionCommands = useStore((s) => s.sessionCommands);
  const attention = useStore((s) => s.attention);
  const sessionCountInActive = useStore((s) =>
    Object.values(s.sessions).filter((sess) => sess.primaryTabId === s.activePrimaryTabId).length,
  );

  const commandsByKind = useMemo(() => {
    const m: Record<string, SessionCommand> = {};
    for (const c of sessionCommands) m[c.type] = c;
    return m;
  }, [sessionCommands]);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  // Non-null when the palette is in the inline "rename this session" prompt:
  // the search input becomes a rename field for the captured session.
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;

  useEffect(() => {
    if (show) {
      setQuery("");
      setSelected(0);
      setRenaming(null);
      // give the modal a tick to mount before focusing
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [show]);

  const startRename = () => {
    if (!activeSession) return;
    setRenaming({ id: activeSession.id, draft: activeSession.label });
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const commitRename = () => {
    if (!renaming) return;
    const label = renaming.draft.trim();
    const current = sessions[renaming.id]?.label;
    if (label && label !== current) {
      sendMessage({ type: "rename", entity: "session", id: renaming.id, label });
    }
    toggle();
  };

  const addSession = (kind: SessionKind) => {
    if (!activePrimaryTabId) return;
    const cmd = commandsByKind[kind];
    const prefix = cmd ? cmd.label.split(" ")[0] : "Session";
    const label = `${prefix} ${sessionCountInActive + 1}`;
    const id = uuid();
    requestFocus(id);
    sendMessage({ type: "session:create", id, primaryTabId: activePrimaryTabId, label, kind });
  };

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];

    const openTabs = Object.values(primaryTabs)
      .filter((t) => t.closedAt == null)
      .sort((a, b) => a.position - b.position);
    const tabLabel: Record<string, string> = {};
    for (const t of openTabs) tabLabel[t.id] = t.label;

    // Top: every attention-pending session across workspaces. Listed here as a
    // shortcut row (inAttention=true) and also kept in its normal slot below;
    // `filtered` decides which view wins based on whether the user is searching.
    for (const sid of attention) {
      const s = sessions[sid];
      if (s && s.closedAt == null) {
        out.push({
          kind: "session",
          id: s.id,
          label: s.label,
          session: s,
          workspaceLabel: tabLabel[s.primaryTabId] ?? "",
          inActive: s.primaryTabId === activePrimaryTabId,
          inAttention: true,
          hasAttention: true,
        });
      }
    }

    // Sessions in the active workspace first, in sidebar order.
    if (activePrimaryTabId) {
      const ord = order[activePrimaryTabId] ?? [];
      const seen = new Set<string>();
      for (const ref of ord) {
        const s = sessions[ref];
        if (s && s.closedAt == null && s.primaryTabId === activePrimaryTabId) {
          out.push({
            kind: "session",
            id: s.id,
            label: s.label,
            session: s,
            workspaceLabel: tabLabel[activePrimaryTabId] ?? "",
            inActive: true,
            hasAttention: attention.has(s.id),
          });
          seen.add(s.id);
        }
      }
      // Any session in the active workspace not represented in `order` (defensive).
      for (const s of Object.values(sessions)) {
        if (s.closedAt == null && s.primaryTabId === activePrimaryTabId && !seen.has(s.id)) {
          out.push({
            kind: "session",
            id: s.id,
            label: s.label,
            session: s,
            workspaceLabel: tabLabel[activePrimaryTabId] ?? "",
            inActive: true,
            hasAttention: attention.has(s.id),
          });
        }
      }
    }

    // Sessions in other workspaces, grouped by workspace order.
    for (const t of openTabs) {
      if (t.id === activePrimaryTabId) continue;
      const ord = order[t.id] ?? [];
      const seen = new Set<string>();
      for (const ref of ord) {
        const s = sessions[ref];
        if (s && s.closedAt == null && s.primaryTabId === t.id) {
          out.push({ kind: "session", id: s.id, label: s.label, session: s, workspaceLabel: t.label, inActive: false, hasAttention: attention.has(s.id) });
          seen.add(s.id);
        }
      }
      for (const s of Object.values(sessions)) {
        if (s.closedAt == null && s.primaryTabId === t.id && !seen.has(s.id)) {
          out.push({ kind: "session", id: s.id, label: s.label, session: s, workspaceLabel: t.label, inActive: false, hasAttention: attention.has(s.id) });
        }
      }
    }

    // Workspaces themselves.
    for (const t of openTabs) {
      out.push({ kind: "primaryTab", id: t.id, label: t.label, tab: t });
    }

    // Actions.
    if (activeSession) {
      out.push({
        kind: "action",
        id: "rename-session",
        label: `Rename current session (${activeSession.label})`,
        icon: "rename-session",
        keepOpen: true,
        run: startRename,
      });
    }
    if (activePrimaryTabId) {
      out.push({
        kind: "action",
        id: "new-shell",
        label: "New shell session",
        icon: "plus-shell",
        run: () => addSession("shell"),
      });
      for (const cmd of sessionCommands) {
        out.push({
          kind: "action-launch",
          id: `new-${cmd.type}`,
          label: `New ${cmd.label}`,
          cmd,
          run: () => addSession(cmd.type),
        });
      }
    }
    out.push({
      kind: "action",
      id: "closed-sessions",
      label: "Open closed subtabs…",
      icon: "archive-sessions",
      run: () => toggleClosedSessions(),
    });
    out.push({
      kind: "action",
      id: "closed-tabs",
      label: "Open closed workspaces…",
      icon: "archive-tabs",
      run: () => toggleClosedTabs(),
    });

    return out;
    // `addSession` is stable enough via closure — its inputs are tracked above.
  }, [primaryTabs, sessions, order, activePrimaryTabId, activeSession, sessionCommands, sessionCountInActive, attention, toggleClosedSessions, toggleClosedTabs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Empty query: keep the "Needs attention" section, and drop the duplicate
      // normal-slot rows for sessions surfaced there.
      return entries.filter((e) => {
        if (e.kind === "session" && !e.inAttention && attention.has(e.session.id)) return false;
        return true;
      });
    }
    // Filtering: drop the special attention section entirely; the dot still
    // rides along on matching rows.
    return entries.filter((e) => {
      if (e.kind === "session" && e.inAttention) return false;
      if (e.label.toLowerCase().includes(q)) return true;
      if (e.kind === "session" && e.workspaceLabel.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [entries, query, attention]);

  useEffect(() => {
    if (selected >= filtered.length) setSelected(0);
  }, [filtered.length, selected]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!show) return null;

  const activate = (entry: Entry) => {
    if (entry.kind === "session") {
      if (entry.session.primaryTabId !== activePrimaryTabId) {
        setActivePrimaryTab(entry.session.primaryTabId);
      }
      setActiveSession(entry.session.id);
      focusActiveTerminal();
      toggle();
    } else if (entry.kind === "primaryTab") {
      setActivePrimaryTab(entry.id);
      focusActiveTerminal();
      toggle();
    } else {
      entry.run();
      if (!(entry.kind === "action" && entry.keepOpen)) toggle();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (renaming) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setRenaming(null);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      toggle();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) setSelected((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = filtered[selected];
      if (entry) activate(entry);
      return;
    }
  };

  // Section headers are derived from entry kind/inActive so we don't have to
  // pre-split into buckets — keeps the index stable for keyboard nav.
  const sectionFor = (entry: Entry, prev: Entry | undefined): string | null => {
    const keyOf = (e: Entry | undefined) => {
      if (!e) return null;
      if (e.kind === "session" && e.inAttention) return "attention";
      if (e.kind === "session") return e.inActive ? "this" : `other:${e.workspaceLabel}`;
      if (e.kind === "primaryTab") return "workspaces";
      return "actions";
    };
    const cur = keyOf(entry);
    const prv = keyOf(prev);
    if (cur === prv) return null;
    if (cur === "attention") return "Needs attention";
    if (cur === "this") return "This workspace";
    if (cur && cur.startsWith("other:")) return cur.slice("other:".length);
    if (cur === "workspaces") return "Workspaces";
    return "Actions";
  };

  return (
    <div
      onClick={toggle}
      className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 pt-[15vh]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border)]">
          {renaming ? (
            <Pencil size={15} className="text-[var(--muted)] shrink-0" />
          ) : (
            <Search size={15} className="text-[var(--muted)] shrink-0" />
          )}
          <input
            ref={inputRef}
            value={renaming ? renaming.draft : query}
            onChange={(e) =>
              renaming
                ? setRenaming({ ...renaming, draft: e.target.value })
                : setQuery(e.target.value)
            }
            onKeyDown={onKeyDown}
            placeholder={renaming ? "New session name…" : "Jump to a session, workspace, or action…"}
            className="flex-1 bg-transparent outline-none text-sm text-[var(--text)] placeholder:text-[var(--faint)]"
          />
        </div>

        {renaming && (
          <div className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--faint)] flex items-center gap-3">
            <span><kbd className="mono">⏎</kbd> rename</span>
            <span><kbd className="mono">esc</kbd> cancel</span>
          </div>
        )}

        {!renaming && (
        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="text-sm text-[var(--faint)] px-4 py-6 text-center">No matches.</div>
          )}
          {filtered.map((entry, idx) => {
            const header = sectionFor(entry, filtered[idx - 1]);
            const isSel = idx === selected;
            return (
              <div key={`${entry.kind}:${entry.kind === "session" && entry.inAttention ? "att:" : ""}${entry.id}`}>
                {header && (
                  <div className="px-4 pt-3 pb-1 text-xs uppercase tracking-wide text-[var(--faint)]">
                    {header}
                  </div>
                )}
                <div
                  data-idx={idx}
                  onMouseMove={() => setSelected(idx)}
                  onClick={() => activate(entry)}
                  className={`mx-1 px-3 py-2 rounded-lg cursor-pointer flex items-center gap-2 text-sm ${
                    isSel
                      ? "bg-[var(--hover)] text-[var(--text)]"
                      : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  }`}
                >
                  <span className="shrink-0">{iconFor(entry, commandsByKind)}</span>
                  <span className="truncate flex-1">{entry.label}</span>
                  {entry.kind === "session" && entry.hasAttention && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0 animate-pulse"
                      style={{ background: "var(--orange)" }}
                      title="Claude wants your attention"
                    />
                  )}
                  {entry.kind === "session" && (!entry.inActive || entry.inAttention) && entry.workspaceLabel && (
                    <span className="text-xs text-[var(--faint)] mono truncate max-w-[40%]">
                      {entry.workspaceLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        )}

        {!renaming && (
        <div className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--faint)] flex items-center gap-3">
          <span><kbd className="mono">↑↓</kbd> navigate</span>
          <span><kbd className="mono">⏎</kbd> select</span>
          <span><kbd className="mono">esc</kbd> close</span>
        </div>
        )}
      </div>
    </div>
  );
}
