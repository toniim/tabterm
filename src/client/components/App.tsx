import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { useStore } from "../store.ts";
import { sendMessage } from "../ws.ts";
import { ClosedSessionsModal } from "./ClosedSessionsModal.tsx";
import { ClosedTabsModal } from "./ClosedTabsModal.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Header } from "./Header.tsx";
import { PrimaryTabs } from "./PrimaryTabs.tsx";
import { RightPanel } from "./RightPanel.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";

export function App() {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeSessionId ? s.sessions[activeSessionId] : null));
  const showNotes = useStore((s) => s.showNotes);
  const toggleCommandPalette = useStore((s) => s.toggleCommandPalette);

  // Capture-phase listener so it preempts xterm's custom key handler in Terminal.tsx.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        toggleCommandPalette();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleCommandPalette]);

  return (
    <div className="h-full flex flex-col bg-[var(--bg)]">
      <Header />
      <PrimaryTabs />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        {session ? (
          session.closedAt != null ? (
            <div className="flex-1 m-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] flex flex-col items-center justify-center gap-4 text-sm">
              <div className="text-[var(--muted)]">
                This subtab is closed. Its shell is not running.
              </div>
              <button
                onClick={() => sendMessage({ type: "session:reopen", sessionId: session.id })}
                className="flex items-center gap-2 px-4 h-9 rounded-lg border border-[var(--border-2)] text-[var(--text)] hover:bg-[var(--hover)]"
              >
                <RotateCcw size={14} /> Reopen subtab
              </button>
              <div className="text-xs text-[var(--faint)]">
                Notes remain available on the right.
              </div>
            </div>
          ) : (
            <TerminalPanel session={session} />
          )
        ) : (
          <div className="flex-1 m-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] flex items-center justify-center text-[var(--faint)] text-sm">
            Select or create a subtab to begin.
          </div>
        )}
        {session && showNotes && <RightPanel sessionId={session.id} />}
      </div>
      <StatusBar />
      <ClosedSessionsModal />
      <ClosedTabsModal />
      <CommandPalette />
    </div>
  );
}
