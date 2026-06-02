// v0.3 acceptance: layout (move-into-group, reorder, ungroup) + rename,
// broadcast to a second client, and persistence via /api/state.

const BASE = "http://localhost:3000";
const WS = "ws://localhost:3000/ws";

const tabId = Object.keys((await (await fetch(`${BASE}/api/state`)).json()).primaryTabs)[0];

const open = () =>
  new Promise<WebSocket>((res) => {
    const ws = new WebSocket(WS);
    ws.onopen = () => res(ws);
  });

const a = await open();
const b = await open();

// Record everything clientB sees, so we can assert broadcasts.
const seen: any[] = [];
b.onmessage = (ev) => seen.push(JSON.parse(ev.data as string));

const waitB = (pred: (m: any) => boolean, label: string) =>
  new Promise<any>((resolve, reject) => {
    const found = seen.find(pred);
    if (found) return resolve(found);
    const t = setInterval(() => {
      const f = seen.find(pred);
      if (f) {
        clearInterval(t);
        resolve(f);
      }
    }, 20);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error(`timeout waiting for ${label}`));
    }, 2000);
  });

const send = (m: any) => a.send(JSON.stringify(m));
const ask = <T,>(pred: (m: any) => boolean): Promise<T> =>
  new Promise((resolve) => {
    const h = (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string);
      if (pred(m)) {
        a.removeEventListener("message", h);
        resolve(m);
      }
    };
    a.addEventListener("message", h);
  });

// --- build: 1 group + 2 ungrouped sessions ---
const gP = ask<any>((m) => m.entity === "group" && m.op === "set");
send({ type: "group:create", primaryTabId: tabId, label: "backend", color: "blue" });
const G = (await gP).data.id;

const s1P = ask<any>((m) => m.entity === "session" && m.op === "set");
send({ type: "session:create", primaryTabId: tabId, label: "s1" });
const S1 = (await s1P).data.id;

const s2P = ask<any>((m) => m.entity === "session" && m.op === "set");
send({ type: "session:create", primaryTabId: tabId, label: "s2" });
const S2 = (await s2P).data.id;
console.log("[v3] built G,S1,S2");

// --- layout: move S1 into G; top = [G, S2] ---
send({ type: "layout", primaryTabId: tabId, order: [G, S2], groups: { [G]: [S1] } });
const moved = await waitB(
  (m) => m.entity === "session" && m.op === "set" && m.data.id === S1 && m.data.groupId === G,
  "S1 moved into G (clientB)",
);
console.log("[v3] S1 grouped on clientB:", moved.data.groupId === G, "pos:", moved.data.position);

// --- rename S2 ---
send({ type: "rename", entity: "session", id: S2, label: "s2-renamed" });
const renamed = await waitB(
  (m) => m.entity === "session" && m.op === "set" && m.data.id === S2 && m.data.label === "s2-renamed",
  "S2 rename (clientB)",
);
console.log("[v3] S2 renamed on clientB:", renamed.data.label);

// --- reorder top: [S2, G] ---
send({ type: "layout", primaryTabId: tabId, order: [S2, G], groups: { [G]: [S1] } });
await waitB(
  (m) => m.entity === "order" && m.op === "set" && JSON.stringify(m.data.order) === JSON.stringify([S2, G]),
  "reordered top (clientB)",
);
console.log("[v3] top reordered on clientB: [S2, G]");

a.close();
b.close();

// --- persistence ---
const st = await (await fetch(`${BASE}/api/state`)).json();
const okGroup = st.sessions[S1]?.groupId === G && st.sessions[S1]?.position === 0;
const okUngrouped = st.sessions[S2]?.groupId === null;
const okRename = st.sessions[S2]?.label === "s2-renamed";
const okOrder = JSON.stringify(st.order[tabId]) === JSON.stringify([S2, G]);
console.log("[v3] persisted -> S1 grouped:", okGroup, "| S2 ungrouped:", okUngrouped, "| rename:", okRename, "| order:", okOrder);

const pass = okGroup && okUngrouped && okRename && okOrder;
console.log(pass ? "\nV3 PASS" : "\nV3 FAIL");
process.exit(pass ? 0 : 1);
