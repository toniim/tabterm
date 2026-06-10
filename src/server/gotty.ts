import { spawn, type Subprocess } from "bun";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionKind } from "../shared/types.ts";
import { config } from "./config.ts";
import { allSessionIds, sessionMeta, setSessionPort } from "./db.ts";
import { extractGotty, extractSessionInit } from "./embedded.ts";

// One GoTTY process per session. GoTTY itself forks a fresh shell for EACH
// WebSocket connection, so two browsers on the same session get independent
// shells (the "per-client shell" model) while we still track one port/session.

// On-disk fallbacks for dev. In the compiled binary, gotty + session-init are
// extracted from the embedded bunfs at first use via embedded.ts.
const REPO_ROOT = join(import.meta.dir, "../..");
const DISK_GOTTY = config.gottyBin ?? join(REPO_ROOT, "bin/gotty");
const DISK_INIT = join(REPO_ROOT, "src/server/session-init.bash");
const BASE_PORT = config.gottyBasePort;

async function gottyBin(): Promise<string> {
  // User-configured gottyBin always wins (even in compiled mode).
  if (config.gottyBin) return config.gottyBin;
  return (await extractGotty()) ?? DISK_GOTTY;
}

async function sessionInitPath(): Promise<string> {
  if (config.sessionInit && config.sessionInit !== "off") return config.sessionInit;
  return (await extractSessionInit()) ?? DISK_INIT;
}

// The shell command GoTTY forks for each session. By default we launch bash with
// our prompt rcfile (which sources ~/.bashrc first). sessionInit can point at a
// custom rcfile, or be "off" to fall back to a plain $SHELL with no injection.
async function shellCommand(): Promise<string[]> {
  if (config.sessionInit === "off") return [process.env.SHELL || "bash"];
  return ["bash", "--rcfile", await sessionInitPath(), "-i"];
}

// Per-session state dir for AI sessions. We persist one UUID per session up-front;
// session-init.bash then picks --session-id <uuid> (no jsonl in claude's project
// store yet) or --resume <uuid> (jsonl exists) at exec time. Using `--continue`
// would resume whichever conversation in this cwd was touched most recently,
// crossing tabs over after any shell relaunch.
const MARKER_DIR = join(homedir(), ".cache/tabterm/sessions");

function uuidFile(sessionId: string, kind: SessionKind): string {
  return join(MARKER_DIR, `${sessionId}.${kind}.uuid`);
}

function ensureSessionUuid(sessionId: string, kind: SessionKind): string {
  const path = uuidFile(sessionId, kind);
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(raw)) return raw;
  } catch {
    // missing or unreadable — fall through and write a fresh one
  }
  mkdirSync(MARKER_DIR, { recursive: true });
  const uuid = randomUUID();
  writeFileSync(path, uuid);
  return uuid;
}

// Env injected on top of process.env for every session. The TABTERM_* vars let
// shell hooks / AI hooks call back into the server (POST /api/sessions/:id/
// status). When `kind` matches a sessionCommands entry we additionally set
// STARTUP_COMMAND + STARTUP_SESSION_ID and let session-init.bash choose
// --session-id vs --resume at exec time. Unknown kinds fall back to a bare
// shell — safer than killing the session.
function sessionEnv(sessionId: string, kind: SessionKind): Record<string, string> {
  const base = {
    TABTERM_SESSION_ID: sessionId,
    TABTERM_BASE_URL: `http://127.0.0.1:${config.port}`,
  };
  if (kind === "shell") return base;
  const entry = config.sessionCommands.find((c) => c.type === kind);
  if (!entry) return base;
  return {
    ...base,
    STARTUP_COMMAND: entry.command,
    STARTUP_SESSION_ID: ensureSessionUuid(sessionId, kind),
  };
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

// PID files let us SIGKILL orphan gotty children left behind by an ungraceful
// tabterm exit. Without this, an orphan keeps holding its old port — on
// restart, the new gotty fails to bind silently, waitForPort still sees the
// orphan answer, and the session ends up wired to a shell that was launched
// with another session's cwd/env.
function pidFile(sessionId: string): string {
  return join(MARKER_DIR, `${sessionId}.gotty.pid`);
}

function writePidFile(sessionId: string, pid: number): void {
  mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(pidFile(sessionId), String(pid));
}

function removePidFile(sessionId: string): void {
  try { unlinkSync(pidFile(sessionId)); } catch {}
}

// Best-effort: kill any gotty children left behind by a previous tabterm crash.
// Called once at startup, before respawnAll. Safe to call when nothing is stale
// (no dir, no files) — it just returns.
export function reapOrphans(): void {
  let files: string[];
  try {
    files = readdirSync(MARKER_DIR);
  } catch {
    return;
  }
  const pidFiles = files.filter((f) => f.endsWith(".gotty.pid"));
  let killed = 0;
  for (const f of pidFiles) {
    const full = join(MARKER_DIR, f);
    try {
      const pid = Number(readFileSync(full, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
          killed++;
        } catch {
          // ESRCH (already dead) or EPERM — nothing useful to do; the unlink
          // below still clears the stale file.
        }
      }
    } catch {
      // unreadable file — fall through to unlink
    }
    try { unlinkSync(full); } catch {}
  }
  if (killed > 0) console.log(`[gotty] reaped ${killed} orphan gotty process(es)`);
}

// Skip ports the OS already has bound (orphan we couldn't reap, an unrelated
// process, etc.) so spawn() doesn't fight a doomed bind. Cap at 500 attempts
// so a fully-saturated port range fails loudly instead of looping forever.
async function allocatePort(): Promise<number> {
  const used = new Set([...procs.values()].map((p) => p.port));
  for (let i = 0; i < 500; i++) {
    if (used.has(nextPort)) { nextPort++; continue; }
    if (await isAlive(nextPort)) {
      console.warn(`[gotty] port ${nextPort} already in use; skipping`);
      used.add(nextPort);
      nextPort++;
      continue;
    }
    return nextPort++;
  }
  throw new Error(`[gotty] no free port available in range starting at ${BASE_PORT}`);
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
// Retries on the next port if the spawned gotty dies before binding (e.g.,
// another process slipped onto the port between the probe and the spawn).
export async function ensure(sessionId: string): Promise<number> {
  const existing = procs.get(sessionId);
  if (existing && !existing.proc.killed) return existing.port;

  const [bin, cmd] = await Promise.all([gottyBin(), shellCommand()]);
  const meta = sessionMeta(sessionId);
  const cwd = resolveCwd(meta?.cwd);
  if (meta?.cwd && !cwd) {
    console.warn(`[gotty] session ${sessionId} cwd "${meta.cwd}" not found, falling back`);
  }
  const kind = meta?.kind ?? "shell";
  const extraEnv = sessionEnv(sessionId, kind);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const port = await allocatePort();
    const proc = spawn(
      [
        bin,
        "--port", String(port),
        "--address", "127.0.0.1",
        "--permit-write",
        "--ws-origin", ".*",
        ...cmd,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        ...(cwd ? { cwd } : {}),
        env: { ...process.env, ...extraEnv } as Record<string, string>,
      },
    );

    // Race readiness against the child exiting — if gotty dies during startup
    // (port collision, bad binary), waitForPort would otherwise be fooled by
    // an orphan answering on the same port.
    const outcome = await Promise.race<"ready" | "exited" | "timeout">([
      waitForPort(port).then((ok) => (ok ? "ready" : "timeout")),
      proc.exited.then(() => "exited" as const),
    ]);

    if (outcome === "ready" && proc.exitCode === null) {
      procs.set(sessionId, { proc, port });
      setSessionPort(sessionId, port);
      if (proc.pid) writePidFile(sessionId, proc.pid);
      console.log(`[gotty] session ${sessionId} -> ${cmd.join(" ")} on :${port}${cwd ? ` (cwd=${cwd})` : ""}`);
      return port;
    }

    try { proc.kill(); } catch {}
    console.warn(
      `[gotty] session ${sessionId} spawn ${outcome} on :${port} (attempt ${attempt}/5); retrying on next port`,
    );
  }

  throw new Error(`[gotty] session ${sessionId} failed to bind a port after 5 attempts`);
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
  removePidFile(sessionId);
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
