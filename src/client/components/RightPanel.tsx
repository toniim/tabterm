import { useState } from "react";
import { AssistantPanel } from "./AssistantPanel.tsx";
import { NotesPanel } from "./NotesPanel.tsx";

type Tab = "notes" | "assistant";

export function RightPanel({ sessionId }: { sessionId: string }) {
  const [tab, setTab] = useState<Tab>("assistant");

  const tabBtn = (id: Tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      className={`flex-1 text-xs py-2 ${
        tab === id ? "text-white border-b-2 border-blue-400" : "text-gray-400 hover:text-gray-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <aside className="w-80 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-panel)] flex flex-col">
      <div className="flex border-b border-[var(--color-border)]">
        {tabBtn("assistant", "Assistant")}
        {tabBtn("notes", "Notes")}
      </div>
      <div className="flex-1 min-h-0">
        {/* key by session so panels reset their per-session state on switch */}
        {tab === "assistant" ? (
          <AssistantPanel key={sessionId} sessionId={sessionId} />
        ) : (
          <NotesPanel key={sessionId} sessionId={sessionId} />
        )}
      </div>
    </aside>
  );
}
