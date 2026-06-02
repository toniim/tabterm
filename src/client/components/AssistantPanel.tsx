import { useEffect, useRef, useState } from "react";
import type { AiMessage } from "../../shared/types.ts";
import { captureScrollback } from "../terminals.ts";

// Per-session AI chat. History is loaded over REST (GET /api/ai/history) and
// new turns go through POST /api/ai/chat, which captures the live terminal
// scrollback as context (Req 7/9). Enter sends; Shift+Enter inserts a newline.
export function AssistantPanel({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setError(null);
    fetch(`/api/ai/history?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d) => setMessages(d.messages ?? []))
      .catch(() => setError("Failed to load history."));
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", content: message }]);
    setBusy(true);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message, scrollback: captureScrollback(sessionId) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status}).`);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !error && (
          <div className="text-sm text-gray-500">
            Ask about this session. The assistant sees your recent terminal output.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <div
              className={`inline-block max-w-[90%] whitespace-pre-wrap text-left rounded px-2.5 py-1.5 text-sm ${
                m.role === "user"
                  ? "bg-blue-600/30 text-gray-100"
                  : "bg-[var(--color-bg)] text-gray-200"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && <div className="text-sm text-gray-500">thinking…</div>}
        {error && (
          <div className="text-sm text-red-400 border border-red-500/40 rounded p-2">{error}</div>
        )}
      </div>
      <div className="border-t border-[var(--color-border)] p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask the assistant… (Enter to send, Shift+Enter for newline)"
          className="w-full h-16 resize-none rounded bg-[var(--color-bg)] border border-[var(--color-border)] p-2 text-sm text-gray-200 outline-none focus:border-gray-500"
        />
      </div>
    </div>
  );
}
