import { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";
import { uuid } from "../uuid.ts";
import type { Note } from "../../shared/types.ts";
import { TiptapEditor } from "./TiptapEditor.tsx";
import { EditableLabel } from "./EditableLabel.tsx";

// Multi-note workspace per session. Zero notes → identical UX to the prior
// single-textarea panel: one editor with a "Write a note…" placeholder; the
// first keystroke silently creates the note. Two-or-more notes → a compact
// list of titles above the editor; clicking switches active note (persisted
// server-side via Session.activeNoteId).
export function NotesPanel({ sessionId }: { sessionId: string }) {
  const label = useStore((s) => s.sessions[sessionId]?.label ?? "—");
  const storeActiveId = useStore((s) => s.sessions[sessionId]?.activeNoteId ?? null);

  const notes = useStore((s) => s.notes);
  const noteConflicts = useStore((s) => s.noteConflicts);
  const clearNoteConflict = useStore((s) => s.clearNoteConflict);
  const notesForSession = useMemo<Note[]>(
    () =>
      Object.values(notes)
        .filter((n) => n.sessionId === sessionId)
        .sort((a, b) => a.position - b.position),
    [notes, sessionId],
  );

  // The id we minted optimistically during the empty-state first-keystroke
  // flow. Until the server's `note:create` broadcast lands and the store's
  // activeNoteId catches up, this is the only id that knows where to route
  // pending `note:update` messages.
  const pendingId = useRef<string | null>(null);

  // Held so onSwitch can force-blur the editor — that releases TiptapEditor's
  // focused-guard so the new note's content actually loads (the blur from
  // clicking a div isn't guaranteed across browsers).
  const editorRef = useRef<Editor | null>(null);

  // Resolve the active note: prefer the server's value, then our pending id,
  // then fall back to the first note (covers the case where active_note_id
  // points at a deleted note before the next broadcast).
  const resolvedActiveId = useMemo(() => {
    if (storeActiveId && notes[storeActiveId]) return storeActiveId;
    if (pendingId.current && notes[pendingId.current]) return pendingId.current;
    return notesForSession[0]?.id ?? null;
  }, [storeActiveId, notes, notesForSession]);

  // Clear the optimistic id once the store has caught up.
  useEffect(() => {
    if (pendingId.current && storeActiveId === pendingId.current) {
      pendingId.current = null;
    }
  }, [storeActiveId]);

  const activeNote = resolvedActiveId ? notes[resolvedActiveId] ?? null : null;
  const conflicted = !!activeNote && noteConflicts.has(activeNote.id);

  // Pending content edits keyed by note id, flushed 300ms after the last
  // keystroke. Keying by note (not one shared timer) means switching notes
  // flushes the previous note's buffered edit instead of cancelling it.
  const pending = useRef<Map<string, string>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Latest markdown the editor emitted, kept so "keep mine" can force-write it.
  const latestMarkdown = useRef("");
  // Optimistic base version per note for OCC. Each accepted write bumps the
  // server version by one, so we advance our base by one per send (our own
  // echoes therefore don't read as conflicts). The editor re-anchors this to
  // the server's value via onContentLoaded whenever it passively reloads.
  const baseByNote = useRef<Map<string, number>>(new Map());

  const flushPending = () => {
    clearTimeout(timer.current);
    for (const [noteId, content] of pending.current) {
      const base = baseByNote.current.get(noteId) ?? notes[noteId]?.version ?? 1;
      sendMessage({ type: "note:update", noteId, content, baseVersion: base });
      baseByNote.current.set(noteId, base + 1); // optimistic: assume accepted
    }
    pending.current.clear();
  };

  const queueContent = (noteId: string, content: string) => {
    pending.current.set(noteId, content);
    clearTimeout(timer.current);
    timer.current = setTimeout(flushPending, 300);
  };

  // Flush buffered edits on unmount so the last keystrokes aren't lost.
  useEffect(() => () => flushPending(), []);

  const handleChange = (markdown: string) => {
    latestMarkdown.current = markdown;
    // No active note yet → mint one. Subsequent keystrokes route normally.
    if (!activeNote && !pendingId.current) {
      // Don't create a note for an empty editor (tiptap init noise yields "").
      if (!markdown.trim()) return;
      const id = uuid();
      pendingId.current = id;
      sendMessage({ type: "note:create", sessionId, id });
      queueContent(id, markdown);
      return;
    }
    // Prefer pendingId so keystrokes between "+ New note" click and the
    // server's broadcast route to the just-created note, not the old active one.
    const targetId = pendingId.current ?? activeNote?.id;
    if (!targetId) return;
    queueContent(targetId, markdown);
  };

  const onCreate = () => {
    flushPending();
    const id = uuid();
    pendingId.current = id;
    // Drop editor focus so its content-sync effect picks up the new empty note
    // when the broadcast lands instead of holding the previous note's content.
    editorRef.current?.commands.blur();
    sendMessage({ type: "note:create", sessionId, id });
  };

  const onSwitch = (noteId: string) => {
    if (noteId === resolvedActiveId) return;
    flushPending();
    editorRef.current?.commands.blur();
    sendMessage({ type: "note:setActive", sessionId, noteId });
  };

  const onDelete = (noteId: string) => {
    sendMessage({ type: "note:delete", noteId });
  };

  const onRename = (noteId: string, title: string) => {
    sendMessage({ type: "note:update", noteId, title });
  };

  // Conflict resolution. The note's `version` here is already the authoritative
  // value the server resynced via note:conflict, so keep-mine force-writes at
  // that base (accepted), while take-theirs just reloads it. Both blur the
  // editor so its content-sync effect re-anchors the base version.
  const keepMine = () => {
    if (!activeNote) return;
    pending.current.delete(activeNote.id);
    sendMessage({
      type: "note:update",
      noteId: activeNote.id,
      content: latestMarkdown.current,
      baseVersion: activeNote.version,
    });
    baseByNote.current.set(activeNote.id, activeNote.version + 1); // optimistic
    clearNoteConflict(activeNote.id);
    editorRef.current?.commands.blur();
  };
  const takeTheirs = () => {
    if (!activeNote) return;
    pending.current.delete(activeNote.id);
    clearNoteConflict(activeNote.id);
    editorRef.current?.commands.blur();
  };

  const editorContent = activeNote?.content ?? "";
  const showList = notesForSession.length >= 2;
  const chars = editorContent.length;
  const words = editorContent.trim() ? editorContent.trim().split(/\s+/).length : 0;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] text-xs shrink-0">
        <span className="text-[var(--muted)] truncate">
          For session: <span className="font-semibold text-[var(--text)]">{label}</span>
        </span>
        <button
          onClick={onCreate}
          className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--text)] shrink-0"
          title="New note"
        >
          <Plus size={14} /> New
        </button>
      </div>

      {showList && (
        <div className="px-2 py-2 border-b border-[var(--border)] space-y-0.5 max-h-48 overflow-y-auto shrink-0">
          {notesForSession.map((n) => {
            const active = n.id === resolvedActiveId;
            return (
              <div
                key={n.id}
                onClick={() => onSwitch(n.id)}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm ${
                  active
                    ? "bg-[var(--panel)] border border-[var(--border-2)] text-[var(--text)] font-medium shadow-sm"
                    : "border border-transparent text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                }`}
              >
                <EditableLabel
                  value={n.title}
                  onCommit={(v) => onRename(n.id, v)}
                  className="truncate flex-1"
                  bubble
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(n.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-[var(--faint)] hover:text-red-400 shrink-0"
                  title="Delete note"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {conflicted && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300 shrink-0">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="flex-1 min-w-0">
            Changed elsewhere — your edit was based on an older version.
          </span>
          <button
            onClick={keepMine}
            className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 font-medium shrink-0"
            title="Overwrite the remote version with what you have here"
          >
            Keep mine
          </button>
          <button
            onClick={takeTheirs}
            className="px-2 py-0.5 rounded hover:bg-[var(--hover)] shrink-0"
            title="Discard your changes and load the remote version"
          >
            Take theirs
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <TiptapEditor
          content={editorContent}
          version={activeNote?.version ?? 0}
          onChange={handleChange}
          onContentLoaded={(v) => {
            if (resolvedActiveId) baseByNote.current.set(resolvedActiveId, v);
          }}
          placeholder={activeNote ? "Write…" : "Write a note…"}
          editorRef={editorRef}
        />
      </div>

      <div className="flex items-center px-3 h-10 border-t border-[var(--border)] mono text-[11px] text-[var(--faint)] shrink-0">
        <span>
          {words} word(s) · {chars} char(s)
        </span>
      </div>
    </div>
  );
}
