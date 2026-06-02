import { useRef } from "react";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";

// Per-session notes. Each note is an uncontrolled textarea, auto-saved on input
// with a 300ms debounce (Req 8). Keyed by note id so switching sessions / adding
// notes remounts cleanly.
export function NotesPanel({ sessionId }: { sessionId: string }) {
  const notes = useStore((s) => s.notes);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const sessionNotes = Object.values(notes)
    .filter((n) => n.sessionId === sessionId)
    .sort((a, b) => a.position - b.position);

  const onInput = (noteId: string, content: string) => {
    clearTimeout(timers.current[noteId]);
    timers.current[noteId] = setTimeout(() => {
      sendMessage({ type: "note:update", noteId, content });
    }, 300);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {sessionNotes.length === 0 && (
          <div className="text-sm text-gray-500">No notes yet.</div>
        )}
        {sessionNotes.map((note) => (
          <div key={note.id} className="relative group">
            <textarea
              defaultValue={note.content}
              onInput={(e) => onInput(note.id, e.currentTarget.value)}
              placeholder="Write a note…"
              className="w-full h-28 resize-y rounded bg-[var(--color-bg)] border border-[var(--color-border)] p-2 text-sm text-gray-200 outline-none focus:border-gray-500"
            />
            <button
              onClick={() => sendMessage({ type: "note:delete", noteId: note.id })}
              className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 text-xs px-1"
              title="Delete note"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--color-border)] p-2">
        <button
          onClick={() => sendMessage({ type: "note:create", sessionId })}
          className="w-full text-xs py-1.5 rounded bg-[var(--color-bg)] text-gray-300 hover:text-white"
        >
          + Note
        </button>
      </div>
    </div>
  );
}
