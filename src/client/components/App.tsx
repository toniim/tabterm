import { useStore } from "../store.ts";
import { RightPanel } from "./RightPanel.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Terminal } from "./Terminal.tsx";
import { TitleBar } from "./TitleBar.tsx";

export function App() {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeSessionId ? s.sessions[activeSessionId] : null));

  return (
    <div className="h-full flex flex-col">
      <TitleBar />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 bg-[var(--color-bg)]">
          {session ? (
            <Terminal key={session.id} sessionId={session.id} />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm">
              Select or create a session to begin.
            </div>
          )}
        </main>
        {session && <RightPanel sessionId={session.id} />}
      </div>
    </div>
  );
}
