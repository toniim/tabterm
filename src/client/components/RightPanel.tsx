import { BookOpen, ChevronRight } from "lucide-react";
import { sendMessage } from "../ws.ts";
import { NotesPanel } from "./NotesPanel.tsx";

export function RightPanel({ sessionId }: { sessionId: string }) {
  const hideNotes = () => sendMessage({ type: "settings:update", patch: { showNotes: false } });

  return (
    <aside className="w-80 shrink-0 my-3 mr-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--border)] shrink-0">
        <BookOpen size={15} className="text-[var(--accent-soft)]" />
        <span className="text-xs font-semibold tracking-wide text-[var(--text)] flex-1">
          NOTES WORKSPACE
        </span>
        <button onClick={hideNotes} className="text-[var(--muted)] hover:text-[var(--text)]" title="Hide panel">
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <NotesPanel key={sessionId} sessionId={sessionId} />
      </div>
    </aside>
  );
}
