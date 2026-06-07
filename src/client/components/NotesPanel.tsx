import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";

// One note per session: controlled but focus-aware so a remote edit appears live
// except while you're typing. Local edits auto-save with a 300ms debounce.
export function NotesPanel({ sessionId }: { sessionId: string }) {
  const content = useStore((s) => s.notes[sessionId]?.content ?? "");
  const label = useStore((s) => s.sessions[sessionId]?.label ?? "—");

  const [value, setValue] = useState(content);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!focused.current) setValue(content);
  }, [content]);

  const onChange = (next: string) => {
    setValue(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => sendMessage({ type: "note:update", sessionId, content: next }), 300);
  };

  const chars = value.length;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] text-xs">
        <span className="text-[var(--muted)]">
          For session: <span className="font-semibold text-[var(--text)]">{label}</span>
        </span>
      </div>

      <textarea
        value={value}
        onFocus={() => (focused.current = true)}
        onBlur={() => (focused.current = false)}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write a note…"
        className="flex-1 resize-none bg-[var(--bg)] p-3 mono text-sm text-[var(--text)] outline-none"
      />

      <div className="flex items-center px-3 h-10 border-t border-[var(--border)] mono text-[11px] text-[var(--faint)]">
        <span>
          {words} word(s) · {chars} char(s)
        </span>
      </div>
    </div>
  );
}
