// Domain + wire-protocol types shared by the Bun server and the React client.

export const GROUP_COLORS = [
  "slate",
  "red",
  "amber",
  "green",
  "cyan",
  "blue",
  "violet",
  "pink",
] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export interface PrimaryTab {
  id: string;
  label: string;
  position: number;
  // Default working directory for new sessions created under this workspace.
  // Empty string = "$HOME". May contain "~" / "~/..." — resolved server-side.
  cwd: string;
  // null = visible; unix timestamp = hidden from the tab bar, listed in the
  // closed-workspaces modal. Sessions inside are preserved untouched.
  closedAt: number | null;
}

export interface Group {
  id: string;
  primaryTabId: string;
  label: string;
  color: GroupColor;
  isOpen: boolean;
  position: number;
}

// Opaque identifier for the launch profile. "shell" is the reserved default
// (plain bash); anything else is matched against the server's sessionCommands
// list, which says what binary to launch and how to render the button.
export type SessionKind = string;

// A configurable launch profile served from ~/.config/tabterm.json. The server
// uses `command` to spawn; the client uses label/icon/color to render the
// sidebar button + command-palette action for this kind.
export interface SessionCommand {
  type: string;
  label: string;
  icon: string;
  command: string;
  color?: string;
}

// Runtime liveness signal. Not persisted: starts undefined (treated as "idle")
// on boot and changes via OSC-133 markers (shell) or AI-kind hooks.
export type SessionStatus = "running" | "idle";

export interface Session {
  id: string;
  primaryTabId: string;
  groupId: string | null;
  label: string;
  cwd: string;
  gottyPort: number | null;
  position: number;
  kind: SessionKind;
  // null = open; unix timestamp = soft-closed (hidden from sidebar, viewable in
  // the closed-sessions list, notes + AI history preserved).
  closedAt: number | null;
  // Which note is shown in the NotesPanel for this session. Persisted so the
  // panel restores to the same note across reloads and server restarts. null
  // when the session has no notes yet.
  activeNoteId: string | null;
  // Absent on persisted records; populated at runtime from the status tracker.
  status?: SessionStatus;
}

// A markdown note belonging to a session. A session can have many; the active
// one is referenced by Session.activeNoteId. Keyed by `id` in AppState.notes.
export interface Note {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  // While true the server keeps `title` in sync with the first non-empty line
  // of `content` (truncated). Flipped to false the first time the user renames
  // the note manually.
  titleAutoDerived: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
  // Monotonic counter bumped on every content/title write. Drives optimistic
  // concurrency: a `note:update` carrying a `baseVersion` older than this is a
  // stale write and the server rejects it instead of clobbering newer content.
  version: number;
}

// Global terminal display preferences. Synced across all clients (persisted in
// the single-row `settings` DB table) so every device renders terminals alike.
// `termFontFamily` is a full CSS font stack; `termTheme` names a TERM_THEMES preset.
export interface AppSettings {
  termFontFamily: string;
  termFontSize: number;
  termLineHeight: number;
  termTheme: string;
  // Layout panel visibility, persisted server-side so it survives a refresh.
  showSidebar: boolean;
  showNotes: boolean;
}

// Full application state sent on connect and held in the client store.
// `order` maps a primaryTabId to its flat sidebar order of `groupId | sessionId`.
export interface AppState {
  primaryTabs: Record<string, PrimaryTab>;
  groups: Record<string, Group>;
  sessions: Record<string, Session>;
  order: Record<string, string[]>;
  notes: Record<string, Note>;
  settings: AppSettings;
}

export type Entity = "primaryTab" | "group" | "session" | "order" | "note" | "settings";

// Server → Client
export type ServerMessage =
  | { type: "init"; state: AppState; sessionCommands: SessionCommand[] }
  | { type: "patch"; entity: Entity; op: "set"; data: unknown }
  | { type: "patch"; entity: Entity; op: "delete"; id: string }
  // Ephemeral attention ping (not persisted). Emitted when a claude-backed
  // session fires a Notification hook; the client badges the session and may
  // raise a browser notification unless that session is already focused.
  | { type: "notify"; sessionId: string; message: string }
  // Sent only to the client whose `note:update` was rejected as stale. Carries
  // the authoritative note so the client can resync and surface the conflict
  // (its in-flight edit was based on an older version and was not applied).
  | { type: "note:conflict"; note: Note };

// Client → Server
export type ClientMessage =
  // `id` is optional: when the client supplies one it can focus the new session
  // immediately (before the broadcast round-trips); otherwise the server mints it.
  | { type: "session:create"; primaryTabId: string; groupId?: string; label: string; id?: string; kind?: SessionKind }
  | { type: "session:close"; sessionId: string }
  | { type: "session:reopen"; sessionId: string }
  | { type: "session:purge"; sessionId: string }
  | { type: "group:create"; primaryTabId: string; label: string; color: GroupColor }
  | { type: "group:toggle"; groupId: string }
  | { type: "tab:create"; label: string; cwd?: string; id?: string }
  | { type: "tab:setCwd"; tabId: string; cwd: string }
  | { type: "tab:close"; tabId: string }
  | { type: "tab:reopen"; tabId: string }
  // New order of the visible primary tabs (left-to-right), by id. The server
  // reassigns each listed tab's `position` to its index.
  | { type: "tab:reorder"; order: string[] }
  | { type: "tab:purge"; tabId: string }
  | { type: "rename"; entity: "primaryTab" | "group" | "session"; id: string; label: string }
  // Full desired sidebar layout for a tab after a drag. `order` is the flat
  // top-level list of `groupId | sessionId`; `groups` maps each groupId to its
  // ordered child session ids. The server derives groupId/position from this.
  | { type: "layout"; primaryTabId: string; order: string[]; groups: Record<string, string[]> }
  // Create a new note for a session. `id` is optional — clients usually mint
  // one so the local UI can switch to it without waiting for the broadcast.
  | { type: "note:create"; sessionId: string; id?: string }
  // Update a note's content, title, or both. When `title` is sent the server
  // also flips `titleAutoDerived = false` so subsequent content edits don't
  // overwrite the user's chosen title. `baseVersion` (content edits) is the
  // note version the edit was based on; the server rejects the write if the
  // note has since advanced, so a stale client can't clobber newer content.
  | { type: "note:update"; noteId: string; content?: string; title?: string; baseVersion?: number }
  | { type: "note:delete"; noteId: string }
  | { type: "note:setActive"; sessionId: string; noteId: string }
  // Update one or more global terminal display preferences. Server clamps
  // numeric fields, persists the single settings row, and broadcasts the result.
  | { type: "settings:update"; patch: Partial<AppSettings> };
