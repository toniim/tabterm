import type { ServerWebSocket } from "bun";
import { ensure, portOf, tmuxEnabled } from "./gotty.ts";
import { setStatus } from "./status.ts";

// Shared-terminal proxy: every browser connection to a session attaches to ONE
// upstream GoTTY connection (one shell), so all devices see identical output
// and any device's input reaches the same shell (tmux-style sharing). The
// upstream is kept alive while viewers come and go so shell state persists.

export interface ProxyData {
  kind: "gotty";
  sessionId: string;
}

interface Shared {
  sessionId: string;
  upstream: WebSocket | null;
  ready: boolean;
  clients: Set<ServerWebSocket<ProxyData>>;
  sizes: Map<ServerWebSocket<ProxyData>, { cols: number; rows: number }>;
  outQueue: string[]; // GoTTY-framed frames buffered until upstream is open
  buffer: Uint8Array[]; // recent decoded output, replayed to new clients
  bufferBytes: number;
  lastSize: string; // last resize frame sent, to avoid spamming
}

const BUFFER_CAP = 128 * 1024;
// gotty v1.5.0 ws_wrapper.Read uses a fixed 1024-byte buffer and errors with
// "Client message exceeded buffer size" on larger messages — that tears down
// the PTY and tmux clients print "lost tty". Cap each upstream input frame so
// "1" + payload stays within the buffer.
const GOTTY_INPUT_MAX = 1023;
const td = new TextDecoder();
const sessions = new Map<string, Shared>();

function fromBase64(s: string): Uint8Array {
  return Uint8Array.fromBase64 ? Uint8Array.fromBase64(s) : new Uint8Array(Buffer.from(s, "base64"));
}

// Scan a chunk of PTY output for OSC-133 shell-integration markers emitted by
// session-init.bash and update the session's running/idle status accordingly.
// `;C` = command start; `;A` (prompt) / `;D` (command done) = back at the prompt.
// Last marker in the chunk wins, so a "C ... D" burst inside one frame resolves
// to idle as expected.
const OSC133 = [0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b]; // ESC ] 1 3 3 ;
function detectShellStatus(sessionId: string, bytes: Uint8Array): void {
  let last: "running" | "idle" | null = null;
  outer: for (let i = 0; i <= bytes.length - OSC133.length - 1; i++) {
    for (let k = 0; k < OSC133.length; k++) {
      if (bytes[i + k] !== OSC133[k]) continue outer;
    }
    const tag = bytes[i + OSC133.length];
    if (tag === 0x43) last = "running";          // 'C'
    else if (tag === 0x41 || tag === 0x44) last = "idle"; // 'A' or 'D'
  }
  if (last) setStatus(sessionId, last);
}

function bufferOutput(s: Shared, bytes: Uint8Array): void {
  s.buffer.push(bytes);
  s.bufferBytes += bytes.length;
  while (s.bufferBytes > BUFFER_CAP && s.buffer.length > 1) {
    s.bufferBytes -= s.buffer.shift()!.length;
  }
}

function sendUpstream(s: Shared, frame: string): void {
  if (s.upstream && s.ready) s.upstream.send(frame);
  else s.outQueue.push(frame);
}

// Resize the shared PTY to the smallest attached client (so no client's view is
// clipped), matching tmux's behavior with multiple attached terminals.
function applyMinSize(s: Shared): void {
  if (s.sizes.size === 0) return;
  let cols = Infinity;
  let rows = Infinity;
  for (const { cols: c, rows: r } of s.sizes.values()) {
    cols = Math.min(cols, c);
    rows = Math.min(rows, r);
  }
  const frame = "3" + JSON.stringify({ columns: cols, rows: rows });
  if (frame !== s.lastSize) {
    s.lastSize = frame;
    sendUpstream(s, frame);
  }
}

async function connectUpstream(s: Shared): Promise<void> {
  const port = portOf(s.sessionId) ?? (await ensure(s.sessionId));
  const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  s.upstream = upstream;

  upstream.onopen = () => {
    upstream.send(JSON.stringify({ AuthToken: "", Arguments: "" }));
    s.ready = true;
    for (const frame of s.outQueue) upstream.send(frame);
    s.outQueue = [];
  };

  upstream.onmessage = (ev) => {
    const data = typeof ev.data === "string" ? ev.data : td.decode(ev.data as ArrayBuffer);
    if (data[0] !== "1") return; // only Output frames matter to xterm
    const bytes = fromBase64(data.slice(1));
    // Under tmux the poller owns shell-session status; skip the OSC-133 scanner
    // to avoid a dual-writer race (and because OSC-133 may not survive tmux).
    if (!tmuxEnabled()) detectShellStatus(s.sessionId, bytes);
    bufferOutput(s, bytes);
    for (const client of s.clients) client.send(bytes);
  };

  // Upstream gone (GoTTY died / restarted): drop the shared entry so the next
  // client connect recreates it against the (possibly respawned) process.
  const teardown = () => {
    if (sessions.get(s.sessionId) === s) sessions.delete(s.sessionId);
    for (const client of s.clients) client.close();
  };
  upstream.onclose = teardown;
  upstream.onerror = teardown;
}

export async function onOpen(ws: ServerWebSocket<ProxyData>): Promise<void> {
  const { sessionId } = ws.data;
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      upstream: null,
      ready: false,
      clients: new Set(),
      sizes: new Map(),
      outQueue: [],
      buffer: [],
      bufferBytes: 0,
      lastSize: "",
    };
    sessions.set(sessionId, s); // register synchronously to avoid double-create
    await connectUpstream(s);
  }
  s.clients.add(ws);
  // Replay recent output so a newly-attached device isn't blank.
  for (const chunk of s.buffer) ws.send(chunk);
}

export function onMessage(ws: ServerWebSocket<ProxyData>, message: string | Buffer): void {
  const s = sessions.get(ws.data.sessionId);
  if (!s) return;
  if (typeof message === "string") {
    try {
      const { cols, rows } = JSON.parse(message) as { cols: number; rows: number };
      s.sizes.set(ws, { cols, rows });
      applyMinSize(s);
    } catch {
      // ignore malformed resize
    }
    return;
  }
  // Fragment large pastes — gotty errors out on a single >1024-byte frame.
  const bytes = message instanceof Buffer
    ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
    : new Uint8Array(message);
  for (let i = 0; i < bytes.length; ) {
    let end = Math.min(i + GOTTY_INPUT_MAX, bytes.length);
    // Back off the cut point so we don't slice a UTF-8 multi-byte sequence in
    // half — the next frame would start with a continuation byte and Bun would
    // refuse to send it as a text frame.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    sendUpstream(s, "1" + td.decode(bytes.subarray(i, end))); // GoTTY Input
    i = end;
  }
}

export function onClose(ws: ServerWebSocket<ProxyData>): void {
  const s = sessions.get(ws.data.sessionId);
  if (!s) return;
  s.clients.delete(ws);
  s.sizes.delete(ws);
  applyMinSize(s);
  // Keep the upstream open with no viewers so shell state survives reconnects.
}
