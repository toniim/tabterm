// Registry mapping a sessionId to a function that snapshots its live xterm
// scrollback. The Terminal component registers on mount; the AssistantPanel
// reads at query time (Req 7 — scrollback captured live, never stored).
type ScrollbackFn = () => string[];

const registry = new Map<string, ScrollbackFn>();

export function registerScrollback(sessionId: string, fn: ScrollbackFn): () => void {
  registry.set(sessionId, fn);
  return () => {
    if (registry.get(sessionId) === fn) registry.delete(sessionId);
  };
}

export function captureScrollback(sessionId: string, maxRows = 100): string[] {
  return registry.get(sessionId)?.().slice(-maxRows) ?? [];
}
