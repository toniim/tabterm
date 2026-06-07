import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { homedir } from "node:os";
import { loadState } from "./db.ts";

// Minimal REST surface for v0.1. The app's live data flows over the WS;
// these endpoints are for health checks and non-WS state inspection.
export function handleApi(url: URL): Response | null {
  if (url.pathname === "/api/health") {
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/state") {
    return Response.json(loadState());
  }
  if (url.pathname === "/api/fs/ls") {
    return handleFsLs(url);
  }
  return null;
}

// List immediate child directories of `path` (or $HOME when omitted) so the
// client can render a tree-walking folder picker for the workspace cwd.
// Hidden directories (dotfiles) are excluded by default.
function handleFsLs(url: URL): Response {
  const raw = url.searchParams.get("path") ?? "";
  const showHidden = url.searchParams.get("hidden") === "1";

  let path = raw.trim();
  if (!path || path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return Response.json({ error: "path must be absolute" }, { status: 400 });
  path = normalize(path);

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return Response.json({ error: "not a directory" }, { status: 400 });
  }

  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((e) => (showHidden ? true : !e.name.startsWith(".")))
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return Response.json({ error: "permission denied" }, { status: 403 });
  }

  const parent = path === "/" ? null : dirname(path);
  return Response.json({ path, parent, home: homedir(), entries });
}
