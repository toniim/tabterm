import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionCommand } from "../shared/types.ts";

// Prod (compiled binary or NODE_ENV=production) reads ~/.config/tabterm.json.
// Dev reads config.sample.json from the repo root, so iterating locally never
// touches the prod DB. Every field is optional and falls back to a default.
interface FileConfig {
  dbPath?: string;
  port?: number;
  gottyBin?: string;
  gottyBasePort?: number;
  sessionInit?: string;
  // "off" disables the tmux-backed durable-session layer (sessions then run as
  // direct child shells, as before). Any other value / unset = use tmux when available.
  tmux?: string;
  // Launch profiles surfaced as sidebar/palette buttons beyond the bare-shell
  // default. Each entry maps a session `kind` (DB column) to the binary that
  // runs on entry plus the label/icon/color shown in the UI.
  sessionCommands?: SessionCommand[];
}

// No baked-in launch profiles by default — a fresh install shows only the plain
// "+ shell" action. Define `sessionCommands` in the config file to add buttons
// that launch a custom command (e.g. an AI CLI) as a session.
const DEFAULT_SESSION_COMMANDS: SessionCommand[] = [];

const HOME = homedir();
const COMPILED = import.meta.dir.startsWith("/$bunfs/");
const IS_PROD = COMPILED || process.env.NODE_ENV === "production";
const CONFIG_PATH = IS_PROD
  ? join(HOME, ".config/tabterm.json")
  : join(dirname(import.meta.dir), "..", "config.sample.json");

function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

function loadFile(): FileConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FileConfig;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    console.warn(`[config] ignoring ${CONFIG_PATH}: ${e.message}`);
    return {};
  }
}

const file = loadFile();
console.log(`[config] ${IS_PROD ? "prod" : "dev"} → ${CONFIG_PATH}`);

export const config = {
  dbPath: expandHome(file.dbPath ?? "~/.config/tabterm.db"),
  port: file.port ?? 3000,
  gottyBin: file.gottyBin ? expandHome(file.gottyBin) : undefined,
  gottyBasePort: file.gottyBasePort ?? 4001,
  sessionInit: file.sessionInit,
  tmux: file.tmux,
  sessionCommands: (file.sessionCommands ?? DEFAULT_SESSION_COMMANDS).map((c) => ({
    ...c,
    command: expandHome(c.command),
  })),
};
