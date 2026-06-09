import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Layers, Plus, Search, Sparkles, TerminalSquare } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { PrimaryTab, Session, SessionKind } from "../../shared/types.ts";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";

type Entry =
  | { kind: "session"; id: string; label: string; session: Session; workspaceLabel: string; inActive: boolean }
  | { kind: "primaryTab"; id: string; label: string; tab: PrimaryTab }
  | { kind: "action"; id: string; label: string; run: () => void; icon: "plus-shell" | "plus-claude" | "archive-sessions" | "archive-tabs" };

function iconFor(entry: Entry) {
  if (entry.kind === "session") {
    return entry.session.kind === "claude"
      ? <Sparkles size={14} className="text-[var(--orange)]" />
      : <TerminalSquare size={14} className="text-[var(--muted)]" />;
  }
  if (entry.kind === "primaryTab") return <Layers size={14} className="text-[var(--muted)]" />;
  if (entry.icon === "plus-shell") return <Plus size={14} className="text-[var(--muted)]" />;
  if (entry.icon === "plus-claude") return <Sparkles size={14} className="text-[var(--orange)]" />;
  return <Archive size={14} className="text-[var(--muted)]" />;
}

export function CommandPalette() {
  const show = useStore((s) => s.showCommandPalette);
  const toggle = useStore((s) => s.toggleCommandPalette);
  const activePrimaryTabId = useStore((s) => s.activePrimaryTabId);
  const setActivePrimaryTab = useStore((s) => s.setActivePrimaryTab);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const requestFocus = useStore((s) => s.requestFocus);
  const toggleClosedSessions = useStore((s) => s.toggleClosedSessions);
  const toggleClosedTabs = useStore((s) => s.toggleClosedTabs);

  const primaryTabs = useStore(useShallow((s) => s.primaryTabs));
  const sessions = useStore(useShallow((s) => s.sessions));
  const order = useStore(useShallow((s) => s.order));
  const sessionCountInActive = useStore((s) =>
    Object.values(s.sessions).filter((sess) => sess.primaryTabId === s.activePrimaryTabId).length,
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (show) {
      setQuery("");
      setSelected(0);
      // give the modal a tick to mount before focusing
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [show]);

  const addSession = (kind: SessionKind) => {
    if (!activePrimaryTabId) return;
    const label = kind === "claude" ? `Claude ${sessionCountInActive + 1}` : `Session ${sessionCountInActive + 1}`;
    const id = crypto.randomUUID();
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
          out.push({ kind: "session", id: s.id, label: s.label, session: s, workspaceLabel: t.label, inActive: false });
          seen.add(s.id);
        }
      }
      for (const s of Object.values(sessions)) {
        if (s.closedAt == null && s.primaryTabId === t.id && !seen.has(s.id)) {
          out.push({ kind: "session", id: s.id, label: s.label, session: s, workspaceLabel: t.label, inActive: false });
        }
      }
    }

    // Workspaces themselves.
    for (const t of openTabs) {
      out.push({ kind: "primaryTab", id: t.id, label: t.label, tab: t });
    }

    // Actions.
    if (activePrimaryTabId) {
      out.push({
        kind: "action",
        id: "new-shell",
        label: "New shell session",
        icon: "plus-shell",
        run: () => addSession("shell"),
      });
      out.push({
        kind: "action",
        id: "new-claude",
        label: "New Claude session",
        icon: "plus-claude",
        run: () => addSession("claude"),
      });
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
  }, [primaryTabs, sessions, order, activePrimaryTabId, sessionCountInActive, toggleClosedSessions, toggleClosedTabs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      if (e.label.toLowerCase().includes(q)) return true;
      if (e.kind === "session" && e.workspaceLabel.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [entries, query]);

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
      toggle();
    } else if (entry.kind === "primaryTab") {
      setActivePrimaryTab(entry.id);
      toggle();
    } else {
      entry.run();
      toggle();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
    const cur = entry.kind === "session"
      ? (entry.inActive ? "this" : `other:${entry.workspaceLabel}`)
      : entry.kind === "primaryTab"
        ? "workspaces"
        : "actions";
    const prv = !prev ? null : prev.kind === "session"
      ? (prev.inActive ? "this" : `other:${prev.workspaceLabel}`)
      : prev.kind === "primaryTab"
        ? "workspaces"
        : "actions";
    if (cur === prv) return null;
    if (cur === "this") return "This workspace";
    if (cur.startsWith("other:")) return cur.slice("other:".length);
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
          <Search size={15} className="text-[var(--muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a session, workspace, or action…"
            className="flex-1 bg-transparent outline-none text-sm text-[var(--text)] placeholder:text-[var(--faint)]"
          />
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="text-sm text-[var(--faint)] px-4 py-6 text-center">No matches.</div>
          )}
          {filtered.map((entry, idx) => {
            const header = sectionFor(entry, filtered[idx - 1]);
            const isSel = idx === selected;
            return (
              <div key={`${entry.kind}:${entry.id}`}>
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
                  <span className="shrink-0">{iconFor(entry)}</span>
                  <span className="truncate flex-1">{entry.label}</span>
                  {entry.kind === "session" && !entry.inActive && (
                    <span className="text-xs text-[var(--faint)] mono truncate max-w-[40%]">
                      {entry.workspaceLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--faint)] flex items-center gap-3">
          <span><kbd className="mono">↑↓</kbd> navigate</span>
          <span><kbd className="mono">⏎</kbd> select</span>
          <span><kbd className="mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
