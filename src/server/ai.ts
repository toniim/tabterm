import Anthropic from "@anthropic-ai/sdk";
import type { AiChatRequest } from "../shared/types.ts";
import { addAiTurn, getAiHistory, sessionMeta } from "./db.ts";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;

// Frozen system prompt — kept byte-stable so the conversation prefix stays
// cacheable. All volatile context (label/cwd/scrollback) goes in the user turn.
const SYSTEM =
  "You are an assistant embedded in a developer's terminal workspace. " +
  "The user asks questions about their current terminal session. Each user " +
  "message may include the session label, working directory, and recent " +
  "terminal scrollback as context. Answer concisely and practically. You " +
  "cannot run commands yourself; suggest commands the user can run.";

function hasKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// GET /api/ai/history?sessionId=...
export function handleHistory(url: URL): Response {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
  return Response.json({ messages: getAiHistory(sessionId) });
}

// POST /api/ai/chat
export async function handleChat(req: Request): Promise<Response> {
  if (!hasKey()) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set on the server." },
      { status: 503 },
    );
  }

  let body: AiChatRequest;
  try {
    body = (await req.json()) as AiChatRequest;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { sessionId, message, scrollback } = body;
  if (!sessionId || !message?.trim()) {
    return Response.json({ error: "sessionId and message are required" }, { status: 400 });
  }

  const meta = sessionMeta(sessionId);
  const history = getAiHistory(sessionId);

  // Prior turns are stored raw (no scrollback). Cache the conversation prefix
  // by marking the last prior turn; the volatile current turn stays uncached.
  const messages: Anthropic.MessageParam[] = history.map((t, i) => ({
    role: t.role,
    content:
      i === history.length - 1
        ? [{ type: "text", text: t.content, cache_control: { type: "ephemeral" } }]
        : t.content,
  }));

  const scroll = scrollback?.length ? scrollback.join("\n") : "(no recent output)";
  const enriched =
    `[Session "${meta?.label ?? "unknown"}" — cwd: ${meta?.cwd ?? "~"}]\n` +
    `Recent terminal output:\n${scroll}\n\n` +
    `Question: ${message}`;
  messages.push({ role: "user", content: enriched });

  try {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    });
    const reply = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Persist the raw question + reply (never the scrollback).
    addAiTurn(sessionId, "user", message);
    addAiTurn(sessionId, "assistant", reply);

    return Response.json({ reply });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return Response.json({ error: `Anthropic API error ${err.status}: ${err.message}` }, { status: 502 });
    }
    return Response.json({ error: "AI request failed" }, { status: 502 });
  }
}
