import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type {
  AppState,
  Group,
  GroupColor,
  Note,
  PrimaryTab,
  Session,
  SessionKind,
} from "../shared/types.ts";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS primary_tabs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    cwd TEXT NOT NULL DEFAULT '',
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    primary_tab_id TEXT NOT NULL,
    label TEXT NOT NULL,
    color TEXT NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    primary_tab_id TEXT NOT NULL,
    group_id TEXT,
    label TEXT NOT NULL,
    cwd TEXT NOT NULL DEFAULT '~',
    gotty_port INTEGER,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'shell',
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sidebar_order (
    primary_tab_id TEXT PRIMARY KEY,
    order_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS notes (
    session_id TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

`);

// Add sessions.closed_at to pre-existing databases (NULL = open, unix ts = closed).
const sessionCols = db
  .query<{ name: string }, []>("PRAGMA table_info(sessions)")
  .all()
  .map((c) => c.name);
if (!sessionCols.includes("closed_at")) {
  db.exec("ALTER TABLE sessions ADD COLUMN closed_at INTEGER");
}
if (!sessionCols.includes("kind")) {
  db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'shell'");
}

// Rename the legacy "claude" kind to "opus" so existing rows match the default
// sessionCommands entry. Idempotent: zero rows on a clean DB or a re-run.
{
  const renamed = db.run("UPDATE sessions SET kind = 'opus' WHERE kind = 'claude'").changes;
  if (renamed > 0) console.log(`[db] migrated ${renamed} legacy 'claude' session(s) -> 'opus'`);
}

// Add primary_tabs.cwd to pre-existing databases (empty string = "$HOME").
const primaryTabCols = db
  .query<{ name: string }, []>("PRAGMA table_info(primary_tabs)")
  .all()
  .map((c) => c.name);
if (!primaryTabCols.includes("cwd")) {
  db.exec("ALTER TABLE primary_tabs ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
}
if (!primaryTabCols.includes("closed_at")) {
  db.exec("ALTER TABLE primary_tabs ADD COLUMN closed_at INTEGER");
}

// Migrate the old multi-row notes schema (id, position) to one row per session,
// collapsing a session's notes into a single record in position order.
const noteCols = db
  .query<{ name: string }, []>("PRAGMA table_info(notes)")
  .all()
  .map((c) => c.name);
if (noteCols.includes("position")) {
  db.exec(`
    CREATE TABLE notes_new (
      session_id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT INTO notes_new (session_id, content, updated_at)
      SELECT session_id, group_concat(content, char(10) || char(10)), MAX(updated_at)
      FROM (SELECT * FROM notes ORDER BY position)
      GROUP BY session_id;
    DROP TABLE notes;
    ALTER TABLE notes_new RENAME TO notes;
  `);
}

// ---- row mappers -------------------------------------------------------------

interface PrimaryTabRow {
  id: string; label: string; position: number; cwd: string;
  closed_at: number | null;
}
interface GroupRow {
  id: string; primary_tab_id: string; label: string; color: string;
  is_open: number; position: number;
}
interface SessionRow {
  id: string; primary_tab_id: string; group_id: string | null; label: string;
  cwd: string; gotty_port: number | null; position: number; kind: string;
  closed_at: number | null;
}
interface OrderRow { primary_tab_id: string; order_json: string }
interface NoteRow {
  session_id: string; content: string; updated_at: number;
}

const toPrimaryTab = (r: PrimaryTabRow): PrimaryTab => ({
  id: r.id,
  label: r.label,
  position: r.position,
  cwd: r.cwd ?? "",
  closedAt: r.closed_at,
});
const toGroup = (r: GroupRow): Group => ({
  id: r.id,
  primaryTabId: r.primary_tab_id,
  label: r.label,
  color: r.color as GroupColor,
  isOpen: r.is_open === 1,
  position: r.position,
});
const toSession = (r: SessionRow): Session => ({
  id: r.id,
  primaryTabId: r.primary_tab_id,
  groupId: r.group_id,
  label: r.label,
  cwd: r.cwd,
  gottyPort: r.gotty_port,
  position: r.position,
  kind: (r.kind ?? "shell") as SessionKind,
  closedAt: r.closed_at,
});
const toNote = (r: NoteRow): Note => ({
  sessionId: r.session_id,
  content: r.content,
  updatedAt: r.updated_at,
});

// ---- prepared statements -----------------------------------------------------

const q = {
  allPrimaryTabs: db.query<PrimaryTabRow, []>("SELECT * FROM primary_tabs ORDER BY position"),
  allGroups: db.query<GroupRow, []>("SELECT * FROM groups"),
  allSessions: db.query<SessionRow, []>("SELECT * FROM sessions ORDER BY id"),
  allOrders: db.query<OrderRow, []>("SELECT * FROM sidebar_order"),

  insertPrimaryTab: db.query(
    "INSERT INTO primary_tabs (id, label, position, cwd) VALUES (?, ?, ?, ?)",
  ),
  setPrimaryTabCwd: db.query("UPDATE primary_tabs SET cwd = ? WHERE id = ?"),
  maxTabPos: db.query<{ p: number | null }, []>("SELECT MAX(position) AS p FROM primary_tabs"),
  insertGroup: db.query(
    "INSERT INTO groups (id, primary_tab_id, label, color, is_open, position) VALUES (?, ?, ?, ?, 1, ?)",
  ),
  getGroup: db.query<GroupRow, [string]>("SELECT * FROM groups WHERE id = ?"),
  toggleGroup: db.query("UPDATE groups SET is_open = 1 - is_open WHERE id = ?"),

  insertSession: db.query(
    "INSERT INTO sessions (id, primary_tab_id, group_id, label, cwd, gotty_port, position, kind) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
  ),
  getSession: db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?"),
  setSessionPort: db.query("UPDATE sessions SET gotty_port = ? WHERE id = ?"),
  setSessionGroupPos: db.query("UPDATE sessions SET group_id = ?, position = ? WHERE id = ?"),
  deleteSession: db.query("DELETE FROM sessions WHERE id = ?"),
  closeSession: db.query("UPDATE sessions SET closed_at = unixepoch() WHERE id = ?"),
  reopenSession: db.query("UPDATE sessions SET closed_at = NULL WHERE id = ?"),

  getPrimaryTab: db.query<PrimaryTabRow, [string]>("SELECT * FROM primary_tabs WHERE id = ?"),
  renamePrimaryTab: db.query("UPDATE primary_tabs SET label = ? WHERE id = ?"),
  closePrimaryTab: db.query("UPDATE primary_tabs SET closed_at = unixepoch() WHERE id = ?"),
  reopenPrimaryTab: db.query("UPDATE primary_tabs SET closed_at = NULL WHERE id = ?"),
  deletePrimaryTab: db.query("DELETE FROM primary_tabs WHERE id = ?"),
  tabSessionIds: db.query<{ id: string }, [string]>(
    "SELECT id FROM sessions WHERE primary_tab_id = ?",
  ),
  deleteTabSessions: db.query("DELETE FROM sessions WHERE primary_tab_id = ?"),
  deleteTabGroups: db.query("DELETE FROM groups WHERE primary_tab_id = ?"),
  deleteTabOrder: db.query("DELETE FROM sidebar_order WHERE primary_tab_id = ?"),
  deleteTabNotes: db.query(
    "DELETE FROM notes WHERE session_id IN (SELECT id FROM sessions WHERE primary_tab_id = ?)",
  ),
  renameGroup: db.query("UPDATE groups SET label = ? WHERE id = ?"),
  renameSession: db.query("UPDATE sessions SET label = ? WHERE id = ?"),
  deleteSessionNotes: db.query("DELETE FROM notes WHERE session_id = ?"),
  maxGroupPos: db.query<{ p: number | null }, [string]>(
    "SELECT MAX(position) AS p FROM groups WHERE primary_tab_id = ?",
  ),
  maxSessionPos: db.query<{ p: number | null }, [string]>(
    "SELECT MAX(position) AS p FROM sessions WHERE primary_tab_id = ?",
  ),

  getOrder: db.query<OrderRow, [string]>("SELECT * FROM sidebar_order WHERE primary_tab_id = ?"),
  upsertOrder: db.query(
    "INSERT INTO sidebar_order (primary_tab_id, order_json) VALUES (?, ?) " +
      "ON CONFLICT(primary_tab_id) DO UPDATE SET order_json = excluded.order_json",
  ),

  allNotes: db.query<NoteRow, []>("SELECT * FROM notes"),
  getNote: db.query<NoteRow, [string]>("SELECT * FROM notes WHERE session_id = ?"),
  upsertNote: db.query(
    "INSERT INTO notes (session_id, content, updated_at) VALUES (?, ?, unixepoch()) " +
      "ON CONFLICT(session_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
  ),
};

// ---- state loading -----------------------------------------------------------

export function loadState(): AppState {
  const primaryTabs: AppState["primaryTabs"] = {};
  for (const r of q.allPrimaryTabs.all()) primaryTabs[r.id] = toPrimaryTab(r);

  const groups: AppState["groups"] = {};
  for (const r of q.allGroups.all()) groups[r.id] = toGroup(r);

  const sessions: AppState["sessions"] = {};
  for (const r of q.allSessions.all()) sessions[r.id] = toSession(r);

  const order: AppState["order"] = {};
  for (const r of q.allOrders.all()) order[r.primary_tab_id] = JSON.parse(r.order_json);

  const notes: AppState["notes"] = {};
  for (const r of q.allNotes.all()) notes[r.session_id] = toNote(r);

  return { primaryTabs, groups, sessions, order, notes };
}

function readOrder(primaryTabId: string): string[] {
  const row = q.getOrder.get(primaryTabId);
  return row ? (JSON.parse(row.order_json) as string[]) : [];
}

function writeOrder(primaryTabId: string, order: string[]): void {
  q.upsertOrder.run(primaryTabId, JSON.stringify(order));
}

// ---- seeding -----------------------------------------------------------------

// First boot only: create a default workspace so the UI is never empty.
export function seedIfEmpty(): void {
  if (q.allPrimaryTabs.all().length > 0) return;
  const id = randomUUID();
  q.insertPrimaryTab.run(id, "workspace", 0, "");
  writeOrder(id, []);
}

// ---- mutations ---------------------------------------------------------------
// Each returns the data needed to broadcast minimal patches to clients.

export function createTab(
  label: string,
  cwd: string = "",
  id: string = randomUUID(),
): PrimaryTab {
  const position = (q.maxTabPos.get()?.p ?? -1) + 1;
  q.insertPrimaryTab.run(id, label, position, cwd);
  q.upsertOrder.run(id, "[]");
  return toPrimaryTab(q.getPrimaryTab.get(id)!);
}

export function setTabCwd(tabId: string, cwd: string): PrimaryTab | null {
  if (!q.getPrimaryTab.get(tabId)) return null;
  q.setPrimaryTabCwd.run(cwd, tabId);
  return toPrimaryTab(q.getPrimaryTab.get(tabId)!);
}

// Soft-close a whole workspace: hide it from the tab bar. Sessions inside keep
// their rows untouched; the WS layer kills their shells so we don't leak
// processes for a workspace nobody can see.
export function closeTab(
  tabId: string,
): { tab: PrimaryTab; sessionIds: string[] } | null {
  if (!q.getPrimaryTab.get(tabId)) return null;
  q.closePrimaryTab.run(tabId);
  const sessionIds = q.tabSessionIds.all(tabId).map((r) => r.id);
  return { tab: toPrimaryTab(q.getPrimaryTab.get(tabId)!), sessionIds };
}

// Reopen a hidden workspace. Sessions reappear in whatever state they were in
// (open ones still open, closed ones still closed); the WS layer respawns
// shells for the still-open ones.
export function reopenTab(
  tabId: string,
): { tab: PrimaryTab; sessionIds: string[] } | null {
  if (!q.getPrimaryTab.get(tabId)) return null;
  q.reopenPrimaryTab.run(tabId);
  const sessionIds = q.tabSessionIds
    .all(tabId)
    .map((r) => r.id)
    .filter((id) => q.getSession.get(id)?.closed_at == null);
  return { tab: toPrimaryTab(q.getPrimaryTab.get(tabId)!), sessionIds };
}

// Permanent: drop the workspace row plus every group, session, note, and
// sidebar order belonging to it.
export function purgeTab(
  tabId: string,
): { sessionIds: string[] } | null {
  if (!q.getPrimaryTab.get(tabId)) return null;
  const sessionIds = q.tabSessionIds.all(tabId).map((r) => r.id);
  q.deleteTabNotes.run(tabId);
  q.deleteTabSessions.run(tabId);
  q.deleteTabGroups.run(tabId);
  q.deleteTabOrder.run(tabId);
  q.deletePrimaryTab.run(tabId);
  return { sessionIds };
}

export function createGroup(
  primaryTabId: string,
  label: string,
  color: GroupColor,
): { group: Group; order: string[] } {
  const id = randomUUID();
  const position = (q.maxGroupPos.get(primaryTabId)?.p ?? -1) + 1;
  q.insertGroup.run(id, primaryTabId, label, color, position);
  const order = [...readOrder(primaryTabId), id];
  writeOrder(primaryTabId, order);
  return { group: toGroup(q.getGroup.get(id)!), order };
}

export function toggleGroup(groupId: string): Group | null {
  const existing = q.getGroup.get(groupId);
  if (!existing) return null;
  q.toggleGroup.run(groupId);
  return toGroup(q.getGroup.get(groupId)!);
}

export function createSession(
  primaryTabId: string,
  groupId: string | undefined,
  label: string,
  id: string = randomUUID(),
  kind: SessionKind = "shell",
): { session: Session; order: string[] | null } {
  const position = (q.maxSessionPos.get(primaryTabId)?.p ?? -1) + 1;
  // New sessions inherit the workspace's default cwd. Legacy tabs without a cwd
  // column default to "" — gotty.ts treats that as "start in $HOME".
  const parent = q.getPrimaryTab.get(primaryTabId);
  const cwd = parent?.cwd ?? "";
  q.insertSession.run(id, primaryTabId, groupId ?? null, label, cwd, position, kind);
  // Ungrouped sessions live in the flat sidebar order; grouped sessions are
  // rendered as children of their group, ordered by `position`.
  let order: string[] | null = null;
  if (!groupId) {
    order = [...readOrder(primaryTabId), id];
    writeOrder(primaryTabId, order);
  }
  return { session: toSession(q.getSession.get(id)!), order };
}

// Soft-close: hide from sidebar, kill the shell, but keep notes + AI history.
// Strip the id from the tab's flat order so the sidebar no longer renders it
// (grouped sessions live under their group, so we only touch order for ungrouped).
export function closeSession(
  sessionId: string,
): { session: Session; primaryTabId: string; order: string[] | null } | null {
  const existing = q.getSession.get(sessionId);
  if (!existing) return null;
  q.closeSession.run(sessionId);
  let order: string[] | null = null;
  if (!existing.group_id) {
    const prev = readOrder(existing.primary_tab_id);
    if (prev.includes(sessionId)) {
      order = prev.filter((ref) => ref !== sessionId);
      writeOrder(existing.primary_tab_id, order);
    }
  }
  return {
    session: toSession(q.getSession.get(sessionId)!),
    primaryTabId: existing.primary_tab_id,
    order,
  };
}

// Reopen a soft-closed session. If its group still exists, it re-appears under
// that group; otherwise we drop it back at the bottom of the flat order.
export function reopenSession(
  sessionId: string,
): { session: Session; primaryTabId: string; order: string[] | null } | null {
  const existing = q.getSession.get(sessionId);
  if (!existing) return null;
  q.reopenSession.run(sessionId);
  let order: string[] | null = null;
  const groupStillExists = existing.group_id && q.getGroup.get(existing.group_id);
  if (!groupStillExists) {
    if (existing.group_id) q.setSessionGroupPos.run(null, 0, sessionId);
    const prev = readOrder(existing.primary_tab_id);
    if (!prev.includes(sessionId)) {
      order = [...prev, sessionId];
      writeOrder(existing.primary_tab_id, order);
    }
  }
  return {
    session: toSession(q.getSession.get(sessionId)!),
    primaryTabId: existing.primary_tab_id,
    order,
  };
}

// Permanent: drop the session row + its notes.
export function purgeSession(
  sessionId: string,
): { primaryTabId: string; order: string[] | null } | null {
  const existing = q.getSession.get(sessionId);
  if (!existing) return null;
  q.deleteSession.run(sessionId);
  q.deleteSessionNotes.run(sessionId);
  let order: string[] | null = null;
  if (!existing.group_id) {
    const prev = readOrder(existing.primary_tab_id);
    if (prev.includes(sessionId)) {
      order = prev.filter((ref) => ref !== sessionId);
      writeOrder(existing.primary_tab_id, order);
    }
  }
  return { primaryTabId: existing.primary_tab_id, order };
}

// Apply a full sidebar layout for a tab: persist the flat top-level order and
// derive each session's group_id + position from it. Returns the new order plus
// every session whose group/position was (re)written, for broadcasting.
export function applyLayout(
  primaryTabId: string,
  order: string[],
  groups: Record<string, string[]>,
): { order: string[]; sessions: Session[] } {
  writeOrder(primaryTabId, order);
  const changed: string[] = [];

  order.forEach((ref, i) => {
    // Top-level entries that aren't groups are ungrouped sessions.
    if (!q.getGroup.get(ref)) {
      q.setSessionGroupPos.run(null, i, ref);
      changed.push(ref);
    }
  });

  for (const [groupId, sessionIds] of Object.entries(groups)) {
    sessionIds.forEach((sid, i) => {
      q.setSessionGroupPos.run(groupId, i, sid);
      changed.push(sid);
    });
  }

  const sessions = changed
    .map((id) => q.getSession.get(id))
    .filter((r): r is SessionRow => r !== null)
    .map(toSession);
  return { order, sessions };
}

export type RenamableEntity = "primaryTab" | "group" | "session";

export function renameEntity(
  entity: RenamableEntity,
  id: string,
  label: string,
): PrimaryTab | Group | Session | null {
  if (entity === "primaryTab") {
    if (!q.getPrimaryTab.get(id)) return null;
    q.renamePrimaryTab.run(label, id);
    return toPrimaryTab(q.getPrimaryTab.get(id)!);
  }
  if (entity === "group") {
    if (!q.getGroup.get(id)) return null;
    q.renameGroup.run(label, id);
    return toGroup(q.getGroup.get(id)!);
  }
  if (!q.getSession.get(id)) return null;
  q.renameSession.run(label, id);
  return toSession(q.getSession.get(id)!);
}

export function setSessionPort(sessionId: string, port: number | null): void {
  q.setSessionPort.run(port, sessionId);
}

// Open (non-closed) sessions only. Used by respawnAll on server boot so closed
// sessions don't get a GoTTY shell.
export function allSessionIds(): string[] {
  return q.allSessions.all().filter((r) => r.closed_at == null).map((r) => r.id);
}

// ---- notes -------------------------------------------------------------------

export function upsertNote(sessionId: string, content: string): Note {
  q.upsertNote.run(sessionId, content);
  return toNote(q.getNote.get(sessionId)!);
}

export function getSession(sessionId: string): Session | null {
  const r = q.getSession.get(sessionId);
  return r ? toSession(r) : null;
}

export function sessionMeta(
  sessionId: string,
): { label: string; cwd: string; kind: SessionKind } | null {
  const r = q.getSession.get(sessionId);
  if (!r) return null;
  return {
    label: r.label,
    cwd: r.cwd,
    kind: (r.kind ?? "shell") as SessionKind,
  };
}
