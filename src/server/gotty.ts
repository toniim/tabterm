import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allSessionIds, sessionMeta, setSessionPort } from "./db.ts";

// One GoTTY process per session. GoTTY itself forks a fresh shell for EACH
// WebSocket connection, so two browsers on the same session get independent
// shells (the "per-client shell" model) while we still track one port/session.

const GOTTY_BIN = join(import.meta.dir, "../../bin/gotty");
const BASE_PORT = Number(process.env.GOTTY_BASE_PORT ?? 4001);
const BUNDLED_INIT = join(import.meta.dir, "session-init.bash");

// The shell command GoTTY forks for each session. By default we launch bash with
// our prompt rcfile (which sources ~/.bashrc first). SESSION_INIT can point at a
// custom rcfile, or be "off" to fall back to a plain $SHELL with no injection.
function shellCommand(): string[] {
  const init = process.env.SESSION_INIT;
  if (init === "off") return [process.env.SHELL || "bash"];
  return ["bash", "--rcfile", init || BUNDLED_INIT, "-i"];
}

// Resolve a stored cwd ("", "~", "~/foo", or absolute) to a real directory.
// Returns undefined when the value is empty, doesn't exist, or can't be resolved
// — callers fall back to the server's cwd in that case.
function resolveCwd(stored: string | undefined): string | undefined {
  if (!stored) return undefined;
  const home = homedir();
  let path = stored;
  if (path === "~") path = home;
  else if (path.startsWith("~/")) path = join(home, path.slice(2));
  if (!existsSync(path)) return undefined;
  return path;
}

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
  const cmd = shellCommand();
  const meta = sessionMeta(sessionId);
  const cwd = resolveCwd(meta?.cwd);
  if (meta?.cwd && !cwd) {
    console.warn(`[gotty] session ${sessionId} cwd "${meta.cwd}" not found, falling back`);
  }
  const proc = spawn(
    [
      GOTTY_BIN,
      "--port", String(port),
      "--address", "127.0.0.1",
      "--permit-write",
      "--ws-origin", ".*",
      ...cmd,
    ],
    { stdout: "ignore", stderr: "ignore", ...(cwd ? { cwd } : {}) },
  );
  procs.set(sessionId, { proc, port });
  setSessionPort(sessionId, port);

  const ready = await waitForPort(port);
  if (!ready) console.warn(`[gotty] session ${sessionId} not listening on :${port} in time`);
  else console.log(`[gotty] session ${sessionId} -> ${cmd.join(" ")} on :${port}${cwd ? ` (cwd=${cwd})` : ""}`);
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

async function isAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

// Periodically ping each GoTTY process; respawn any that has exited or stopped
// responding (P1 health check). Returns a stop function.
export function startHealthMonitor(intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const [sessionId, { proc, port }] of [...procs]) {
        const dead = proc.exitCode !== null || !(await isAlive(port));
        if (dead) {
          console.warn(`[gotty] session ${sessionId} unhealthy on :${port}, respawning`);
          kill(sessionId);
          await ensure(sessionId);
        }
      }
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
