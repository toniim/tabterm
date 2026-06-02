import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { allSessionIds, setSessionPort } from "./db.ts";

// One GoTTY process per session. GoTTY itself forks a fresh shell for EACH
// WebSocket connection, so two browsers on the same session get independent
// shells (the "per-client shell" model) while we still track one port/session.

const GOTTY_BIN = join(import.meta.dir, "../../bin/gotty");
const BASE_PORT = Number(process.env.GOTTY_BASE_PORT ?? 4001);
const SHELL = process.env.SHELL || "bash";

interface GoTTYProcess {
  proc: Subprocess;
  port: number;
}

const procs = new Map<string, GoTTYProcess>();
let nextPort = BASE_PORT;

function allocatePort(): number {
  const used = new Set([...procs.values()].map((p) => p.port));
  while (used.has(nextPort)) nextPort++;
  return nextPort++;
}

async function waitForPort(port: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok || res.status === 401) return true;
    } catch {
      // not listening yet
    }
    await Bun.sleep(50);
  }
  return false;
}

// Spawn a GoTTY process for a session (idempotent). Returns its port.
export async function ensure(sessionId: string): Promise<number> {
  const existing = procs.get(sessionId);
  if (existing && !existing.proc.killed) return existing.port;

  const port = allocatePort();
  const proc = spawn(
    [
      GOTTY_BIN,
      "--port", String(port),
      "--address", "127.0.0.1",
      "--permit-write",
      "--ws-origin", ".*",
      SHELL,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  procs.set(sessionId, { proc, port });
  setSessionPort(sessionId, port);

  const ready = await waitForPort(port);
  if (!ready) console.warn(`[gotty] session ${sessionId} not listening on :${port} in time`);
  else console.log(`[gotty] session ${sessionId} -> ${SHELL} on :${port}`);
  return port;
}

export function portOf(sessionId: string): number | undefined {
  return procs.get(sessionId)?.port;
}

export function kill(sessionId: string): void {
  const entry = procs.get(sessionId);
  if (!entry) return;
  entry.proc.kill();
  procs.delete(sessionId);
  setSessionPort(sessionId, null);
  console.log(`[gotty] killed session ${sessionId}`);
}

// Re-spawn GoTTY for every persisted session on server boot (auto-respawn).
export async function respawnAll(): Promise<void> {
  const ids = allSessionIds();
  if (ids.length === 0) return;
  console.log(`[gotty] respawning ${ids.length} session(s) after restart`);
  await Promise.all(ids.map((id) => ensure(id)));
}

export function killAll(): void {
  for (const id of [...procs.keys()]) kill(id);
}
