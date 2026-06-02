// v0.4 acceptance: notes (create/update/delete) broadcast + persist (Req 8),
// AI history endpoint, and AI chat error state when no key is set (Req 9).

const BASE = "http://localhost:3000";
const WS = "ws://localhost:3000/ws";

const tabId = Object.keys((await (await fetch(`${BASE}/api/state`)).json()).primaryTabs)[0];
const open = () => new Promise<WebSocket>((res) => { const w = new WebSocket(WS); w.onopen = () => res(w); });

const a = await open();
const b = await open();
const seen: any[] = [];
b.onmessage = (ev) => seen.push(JSON.parse(ev.data as string));
const waitB = (pred: (m: any) => boolean, label: string) =>
  new Promise<any>((resolve, reject) => {
    const t = setInterval(() => { const f = seen.find(pred); if (f) { clearInterval(t); resolve(f); } }, 20);
    setTimeout(() => { clearInterval(t); reject(new Error("timeout: " + label)); }, 2000);
  });
const ask = (pred: (m: any) => boolean): Promise<any> =>
  new Promise((resolve) => {
    const h = (ev: MessageEvent) => { const m = JSON.parse(ev.data as string); if (pred(m)) { a.removeEventListener("message", h); resolve(m); } };
    a.addEventListener("message", h);
  });

// session to attach notes/AI to
const sP = ask((m) => m.entity === "session" && m.op === "set");
a.send(JSON.stringify({ type: "session:create", primaryTabId: tabId, label: "notes-test" }));
const sid = (await sP).data.id;
console.log("[v4] session:", sid);

// --- note create -> broadcast to B ---
a.send(JSON.stringify({ type: "note:create", sessionId: sid }));
const created = await waitB((m) => m.entity === "note" && m.op === "set", "note create on B");
const noteId = created.data.id;
console.log("[v4] note created & broadcast:", noteId, "empty content:", created.data.content === "");

// --- note update -> broadcast ---
a.send(JSON.stringify({ type: "note:update", noteId, content: "remember: bun run dev" }));
const updated = await waitB((m) => m.entity === "note" && m.op === "set" && m.data.content === "remember: bun run dev", "note update on B");
console.log("[v4] note updated & broadcast:", JSON.stringify(updated.data.content));

// --- persistence ---
let st = await (await fetch(`${BASE}/api/state`)).json();
const persisted = st.notes[noteId]?.content === "remember: bun run dev";
console.log("[v4] note persisted in /api/state:", persisted);

// --- note delete -> broadcast ---
a.send(JSON.stringify({ type: "note:delete", noteId }));
const deleted = await waitB((m) => m.entity === "note" && m.op === "delete" && m.id === noteId, "note delete on B");
console.log("[v4] note delete broadcast:", deleted.id === noteId);
st = await (await fetch(`${BASE}/api/state`)).json();
console.log("[v4] note gone from state:", !st.notes[noteId]);

// --- AI history (empty) ---
const hist = await (await fetch(`${BASE}/api/ai/history?sessionId=${sid}`)).json();
console.log("[v4] ai history is empty array:", Array.isArray(hist.messages) && hist.messages.length === 0);

// --- AI chat error state (no key) ---
const chat = await fetch(`${BASE}/api/ai/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: sid, message: "hi", scrollback: ["$ echo hi", "hi"] }),
});
const chatBody = await chat.json();
const errorState = chat.status === 503 && typeof chatBody.error === "string" && chatBody.error.includes("ANTHROPIC_API_KEY");
console.log(`[v4] ai chat error state (no key): status=${chat.status} error=${JSON.stringify(chatBody.error)} -> ${errorState}`);

a.close();
b.close();

const pass = created.data.content === "" && updated.data.content === "remember: bun run dev" && persisted &&
  deleted.id === noteId && !st.notes[noteId] && Array.isArray(hist.messages) && errorState;
console.log(pass ? "\nV4 PASS" : "\nV4 FAIL");
process.exit(pass ? 0 : 1);
