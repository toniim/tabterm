import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  AppState,
  Group,
  GroupColor,
  PrimaryTab,
  Session,
} from "../shared/types.ts";

mkdirSync("data", { recursive: true });

const db = new Database("data/state.db", { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS primary_tabs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    position INTEGER NOT NULL
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
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sidebar_order (
    primary_tab_id TEXT PRIMARY KEY,
    order_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS ai_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ---- row mappers -------------------------------------------------------------

interface PrimaryTabRow { id: string; label: string; position: number }
interface GroupRow {
  id: string; primary_tab_id: string; label: string; color: string;
  is_open: number; position: number;
}
interface SessionRow {
  id: string; primary_tab_id: string; group_id: string | null; label: string;
  cwd: string; gotty_port: number | null; position: number;
}
interface OrderRow { primary_tab_id: string; order_json: string }

const toPrimaryTab = (r: PrimaryTabRow): PrimaryTab => ({
  id: r.id, label: r.label, position: r.position,
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
});

// ---- prepared statements -----------------------------------------------------

const q = {
  allPrimaryTabs: db.query<PrimaryTabRow, []>("SELECT * FROM primary_tabs ORDER BY position"),
  allGroups: db.query<GroupRow, []>("SELECT * FROM groups"),
  allSessions: db.query<SessionRow, []>("SELECT * FROM sessions"),
  allOrders: db.query<OrderRow, []>("SELECT * FROM sidebar_order"),

  insertPrimaryTab: db.query("INSERT INTO primary_tabs (id, label, position) VALUES (?, ?, ?)"),
  insertGroup: db.query(
    "INSERT INTO groups (id, primary_tab_id, label, color, is_open, position) VALUES (?, ?, ?, ?, 1, ?)",
  ),
  getGroup: db.query<GroupRow, [string]>("SELECT * FROM groups WHERE id = ?"),
  toggleGroup: db.query("UPDATE groups SET is_open = 1 - is_open WHERE id = ?"),

  insertSession: db.query(
    "INSERT INTO sessions (id, primary_tab_id, group_id, label, cwd, gotty_port, position) VALUES (?, ?, ?, ?, '~', NULL, ?)",
  ),
  getSession: db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?"),
  setSessionPort: db.query("UPDATE sessions SET gotty_port = ? WHERE id = ?"),
  setSessionGroupPos: db.query("UPDATE sessions SET group_id = ?, position = ? WHERE id = ?"),
  deleteSession: db.query("DELETE FROM sessions WHERE id = ?"),

  getPrimaryTab: db.query<PrimaryTabRow, [string]>("SELECT * FROM primary_tabs WHERE id = ?"),
  renamePrimaryTab: db.query("UPDATE primary_tabs SET label = ? WHERE id = ?"),
  renameGroup: db.query("UPDATE groups SET label = ? WHERE id = ?"),
  renameSession: db.query("UPDATE sessions SET label = ? WHERE id = ?"),
  deleteSessionNotes: db.query("DELETE FROM notes WHERE session_id = ?"),
  deleteSessionAi: db.query("DELETE FROM ai_history WHERE session_id = ?"),
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

  return { primaryTabs, groups, sessions, order };
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
  q.insertPrimaryTab.run(id, "workspace", 0);
  writeOrder(id, []);
}

// ---- mutations ---------------------------------------------------------------
// Each returns the data needed to broadcast minimal patches to clients.

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
): { session: Session; order: string[] | null } {
  const id = randomUUID();
  const position = (q.maxSessionPos.get(primaryTabId)?.p ?? -1) + 1;
  q.insertSession.run(id, primaryTabId, groupId ?? null, label, position);
  // Ungrouped sessions live in the flat sidebar order; grouped sessions are
  // rendered as children of their group, ordered by `position`.
  let order: string[] | null = null;
  if (!groupId) {
    order = [...readOrder(primaryTabId), id];
    writeOrder(primaryTabId, order);
  }
  return { session: toSession(q.getSession.get(id)!), order };
}

export function deleteSession(
  sessionId: string,
): { primaryTabId: string; order: string[] | null } | null {
  const existing = q.getSession.get(sessionId);
  if (!existing) return null;
  q.deleteSession.run(sessionId);
  q.deleteSessionNotes.run(sessionId);
  q.deleteSessionAi.run(sessionId);
  let order: string[] | null = null;
  if (!existing.group_id) {
    order = readOrder(existing.primary_tab_id).filter((ref) => ref !== sessionId);
    writeOrder(existing.primary_tab_id, order);
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

export function allSessionIds(): string[] {
  return q.allSessions.all().map((r) => r.id);
}
