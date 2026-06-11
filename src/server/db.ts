import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type {
  AppSettings,
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
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT NOT NULL DEFAULT '',
    title_auto_derived INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    version INTEGER NOT NULL DEFAULT 1
  );

  -- Single-row (id = 1) global terminal display preferences, synced to clients.
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    term_font_family TEXT NOT NULL DEFAULT 'ui-monospace, SFMono-Regular, Menlo, monospace',
    term_font_size   INTEGER NOT NULL DEFAULT 13,
    term_line_height REAL NOT NULL DEFAULT 1.0,
    term_theme       TEXT NOT NULL DEFAULT 'Slate Standard',
    show_sidebar     INTEGER NOT NULL DEFAULT 1,
    show_notes       INTEGER NOT NULL DEFAULT 1
  );

`);

// Guarantee the settings row exists on every boot (fresh or pre-existing DB), so
// loadSettings always reads stored values and updateSettings can UPDATE in place.
db.exec("INSERT OR IGNORE INTO settings (id) VALUES (1);");

// Add layout-visibility columns to pre-existing settings rows (default visible).
const settingsCols = db
  .query<{ name: string }, []>("PRAGMA table_info(settings)")
  .all()
  .map((c) => c.name);
if (!settingsCols.includes("show_sidebar")) {
  db.exec("ALTER TABLE settings ADD COLUMN show_sidebar INTEGER NOT NULL DEFAULT 1");
}
if (!settingsCols.includes("show_notes")) {
  db.exec("ALTER TABLE settings ADD COLUMN show_notes INTEGER NOT NULL DEFAULT 1");
}

// Derive a sensible title from the first non-empty line of markdown content.
// Used by the single-row → multi-note migration and by note mutations whenever
// `titleAutoDerived = 1`.
function deriveTitle(content: string): string {
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? "").slice(0, 60) || "Untitled";
}

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
// Which note shows in the NotesPanel for a session; populated by the
// single-row notes migration below for sessions that had a pre-existing note.
if (!sessionCols.includes("active_note_id")) {
  db.exec("ALTER TABLE sessions ADD COLUMN active_note_id TEXT");
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

// Migrate the prior single-row notes schema (session_id PK, content, updated_at)
// to the multi-note schema. Each pre-existing note becomes one row with a
// derived title; sessions.active_note_id points at the migrated note so the
// NotesPanel restores to the same content on next open.
const noteCols = db
  .query<{ name: string }, []>("PRAGMA table_info(notes)")
  .all()
  .map((c) => c.name);
if (!noteCols.includes("id")) {
  interface LegacyNoteRow {
    session_id: string;
    content: string;
    updated_at: number;
  }
  const legacy = db
    .query<LegacyNoteRow, []>("SELECT session_id, content, updated_at FROM notes")
    .all();
  db.transaction(() => {
    db.exec(`
      DROP TABLE notes;
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'Untitled',
        content TEXT NOT NULL DEFAULT '',
        title_auto_derived INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_notes_session ON notes(session_id, position);
    `);
    const insert = db.query(
      "INSERT INTO notes (id, session_id, title, content, title_auto_derived, position, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
    );
    const setActive = db.query("UPDATE sessions SET active_note_id = ? WHERE id = ?");
    for (const r of legacy) {
      const id = randomUUID();
      insert.run(id, r.session_id, deriveTitle(r.content), r.content, r.updated_at, r.updated_at);
      setActive.run(id, r.session_id);
    }
  })();
  if (legacy.length) console.log(`[db] migrated ${legacy.length} note(s) to multi-note schema`);
}

// Add notes.version to pre-existing multi-note DBs (and legacy-migrated ones,
// whose recreate above omits it). Existing rows start at version 1.
const noteColsNow = db
  .query<{ name: string }, []>("PRAGMA table_info(notes)")
  .all()
  .map((c) => c.name);
if (!noteColsNow.includes("version")) {
  db.exec("ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
}

// Index for the now-stable schema; safe on fresh DBs (created by IF NOT EXISTS
// above) and on migrated ones alike.
db.exec("CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, position);");

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
  closed_at: number | null; active_note_id: string | null;
}
interface OrderRow { primary_tab_id: string; order_json: string }
interface NoteRow {
  id: string; session_id: string; title: string; content: string;
  title_auto_derived: number; position: number;
  created_at: number; updated_at: number; version: number;
}
interface SettingsRow {
  id: number; term_font_family: string; term_font_size: number;
  term_line_height: number; term_theme: string;
  show_sidebar: number; show_notes: number;
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
  activeNoteId: r.active_note_id ?? null,
});
const toNote = (r: NoteRow): Note => ({
  id: r.id,
  sessionId: r.session_id,
  title: r.title,
  content: r.content,
  titleAutoDerived: r.title_auto_derived === 1,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version ?? 1,
});
const toSettings = (r: SettingsRow): AppSettings => ({
  termFontFamily: r.term_font_family,
  termFontSize: r.term_font_size,
  termLineHeight: r.term_line_height,
  termTheme: r.term_theme,
  showSidebar: (r.show_sidebar ?? 1) === 1,
  showNotes: (r.show_notes ?? 1) === 1,
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
  setPrimaryTabPos: db.query("UPDATE primary_tabs SET position = ? WHERE id = ?"),
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

  allNotes: db.query<NoteRow, []>("SELECT * FROM notes ORDER BY session_id, position"),
  getNote: db.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?"),
  insertNote: db.query(
    "INSERT INTO notes (id, session_id, title, content, title_auto_derived, position, created_at, updated_at) " +
      "VALUES (?, ?, 'Untitled', '', 1, ?, unixepoch(), unixepoch())",
  ),
  updateNoteContent: db.query(
    "UPDATE notes SET content = ?, version = version + 1, updated_at = unixepoch() WHERE id = ?",
  ),
  updateNoteContentAndTitle: db.query(
    "UPDATE notes SET content = ?, title = ?, version = version + 1, updated_at = unixepoch() WHERE id = ?",
  ),
  updateNoteTitle: db.query(
    "UPDATE notes SET title = ?, title_auto_derived = 0, version = version + 1, updated_at = unixepoch() WHERE id = ?",
  ),
  deleteNote: db.query("DELETE FROM notes WHERE id = ?"),
  // Latest-touched remaining note in the session, excluding the one we're about
  // to delete. Used to pick the next active note when the active one goes away.
  mostRecentNoteForSession: db.query<{ id: string }, [string, string]>(
    "SELECT id FROM notes WHERE session_id = ? AND id != ? ORDER BY updated_at DESC LIMIT 1",
  ),
  maxNotePos: db.query<{ p: number | null }, [string]>(
    "SELECT MAX(position) AS p FROM notes WHERE session_id = ?",
  ),
  setSessionActiveNote: db.query("UPDATE sessions SET active_note_id = ? WHERE id = ?"),

  getSettings: db.query<SettingsRow, []>("SELECT * FROM settings WHERE id = 1"),
  updateSettings: db.query(
    "UPDATE settings SET term_font_family = ?, term_font_size = ?, " +
      "term_line_height = ?, term_theme = ?, show_sidebar = ?, show_notes = ? WHERE id = 1",
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
  for (const r of q.allNotes.all()) notes[r.id] = toNote(r);

  return { primaryTabs, groups, sessions, order, notes, settings: loadSettings() };
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

// Reassign positions for the visible tabs in the given left-to-right order.
// `order` lists only the currently-visible tab ids; hidden tabs keep their
// stored positions and are simply re-sorted among the visible ones if reopened.
export function reorderTabs(order: string[]): PrimaryTab[] {
  const out: PrimaryTab[] = [];
  order.forEach((id, i) => {
    if (!q.getPrimaryTab.get(id)) return;
    q.setPrimaryTabPos.run(i, id);
    out.push(toPrimaryTab(q.getPrimaryTab.get(id)!));
  });
  return out;
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

// Every persisted session id — OPEN and soft-closed. Used only by the tmux
// reconcile: soft-closed sessions keep their tmux session alive (running work)
// for reopen, so reconcile must NOT treat them as orphans. Purged sessions are
// already DELETEd from the table, so absence here means "no backing row".
export function allLiveSessionIds(): string[] {
  return q.allSessions.all().map((r) => r.id);
}

// ---- notes -------------------------------------------------------------------

// Create a fresh note for a session, append it to the position list, and make
// it the active note for that session. Returns the new note plus the updated
// session (so the WS layer can broadcast both patches).
export function createNote(
  sessionId: string,
  id: string = randomUUID(),
): { note: Note; session: Session } | null {
  if (!q.getSession.get(sessionId)) return null;
  const position = (q.maxNotePos.get(sessionId)?.p ?? -1) + 1;
  q.insertNote.run(id, sessionId, position);
  q.setSessionActiveNote.run(id, sessionId);
  return {
    note: toNote(q.getNote.get(id)!),
    session: toSession(q.getSession.get(sessionId)!),
  };
}

// Content-only update: refresh the markdown body and, while the title still
// follows the first line, recompute it from the new content in the same write.
// Optimistic concurrency: when `baseVersion` is supplied and the note has since
// advanced past it, the write is a stale edit — reject it (return applied:false
// + the current note) so the caller can resync the client instead of clobbering
// newer content. Missing baseVersion = unconditional write (back-compat).
export function updateNoteContent(
  noteId: string,
  content: string,
  baseVersion?: number,
): { note: Note; applied: boolean } | null {
  const existing = q.getNote.get(noteId);
  if (!existing) return null;
  if (baseVersion != null && (existing.version ?? 1) !== baseVersion) {
    return { note: toNote(existing), applied: false };
  }
  if (existing.title_auto_derived === 1) {
    q.updateNoteContentAndTitle.run(content, deriveTitle(content), noteId);
  } else {
    q.updateNoteContent.run(content, noteId);
  }
  return { note: toNote(q.getNote.get(noteId)!), applied: true };
}

// Manual rename: stops the first-line auto-derivation so subsequent content
// edits don't clobber the user's chosen title.
export function updateNoteTitle(noteId: string, title: string): Note | null {
  const existing = q.getNote.get(noteId);
  if (!existing) return null;
  q.updateNoteTitle.run(title.trim() || "Untitled", noteId);
  return toNote(q.getNote.get(noteId)!);
}

// Delete a note. If it was the session's active note, promote the most
// recently-touched remaining note (or clear active_note_id if none remain).
// Returns the session id, the deleted note id, and the updated session row
// only when active_note_id actually changed — caller decides whether to
// broadcast the session patch.
export function deleteNote(
  noteId: string,
): { sessionId: string; deletedId: string; session: Session | null } | null {
  const existing = q.getNote.get(noteId);
  if (!existing) return null;
  const sessionId = existing.session_id;
  const sessionRow = q.getSession.get(sessionId);
  q.deleteNote.run(noteId);
  let session: Session | null = null;
  if (sessionRow?.active_note_id === noteId) {
    const next = q.mostRecentNoteForSession.get(sessionId, noteId)?.id ?? null;
    q.setSessionActiveNote.run(next, sessionId);
    session = toSession(q.getSession.get(sessionId)!);
  }
  return { sessionId, deletedId: noteId, session };
}

export function setActiveNote(sessionId: string, noteId: string): Session | null {
  if (!q.getSession.get(sessionId)) return null;
  if (!q.getNote.get(noteId)) return null;
  q.setSessionActiveNote.run(noteId, sessionId);
  return toSession(q.getSession.get(sessionId)!);
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

// ---- settings ----------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
// Runtime-safe coercion for untrusted patch values: `msg.patch` is parsed JSON
// cast to a type, never validated, and the result is persisted + broadcast to
// every client. Reject wrong types / non-finite numbers / oversized strings by
// falling back to the current value instead of fanning garbage out.
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string, max: number): string =>
  typeof v === "string" && v.length <= max ? v : fallback;
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

export function loadSettings(): AppSettings {
  // Row 1 is guaranteed by the boot-time INSERT OR IGNORE above.
  return toSettings(q.getSettings.get()!);
}

// Merge a partial patch onto the stored row, clamping numeric fields to safe
// bounds, and return the full updated settings for broadcasting.
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const cur = loadSettings();
  const next: AppSettings = {
    termFontFamily: str(patch.termFontFamily, cur.termFontFamily, 200),
    termFontSize: clamp(num(patch.termFontSize, cur.termFontSize), 8, 32),
    termLineHeight: clamp(num(patch.termLineHeight, cur.termLineHeight), 1.0, 2.0),
    termTheme: str(patch.termTheme, cur.termTheme, 100),
    showSidebar: bool(patch.showSidebar, cur.showSidebar),
    showNotes: bool(patch.showNotes, cur.showNotes),
  };
  q.updateSettings.run(
    next.termFontFamily,
    next.termFontSize,
    next.termLineHeight,
    next.termTheme,
    next.showSidebar ? 1 : 0,
    next.showNotes ? 1 : 0,
  );
  return next;
}
