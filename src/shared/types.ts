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

// "shell" = plain bash. "claude" = launch the server's configured claudeCommand
// (e.g. ~/bin/opus) on entry; "fable" = launch fableCommand (~/bin/fable). On
// exit the user is dropped back at bash. Both AI kinds share the per-session
// UUID machinery in gotty.ts that pins each shell to its own conversation.
export type SessionKind = "shell" | "claude" | "fable";

// Runtime liveness signal. Not persisted: starts undefined (treated as "idle")
// on boot and changes via OSC-133 markers (shell) or claude hooks (claude/fable).
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
  // Absent on persisted records; populated at runtime from the status tracker.
  status?: SessionStatus;
}

// One note per session. Keyed by sessionId in AppState.notes.
export interface Note {
  sessionId: string;
  content: string;
  updatedAt: number;
}

// Full application state sent on connect and held in the client store.
// `order` maps a primaryTabId to its flat sidebar order of `groupId | sessionId`.
export interface AppState {
  primaryTabs: Record<string, PrimaryTab>;
  groups: Record<string, Group>;
  sessions: Record<string, Session>;
  order: Record<string, string[]>;
  notes: Record<string, Note>;
}

export type Entity = "primaryTab" | "group" | "session" | "order" | "note";

// Server → Client
export type ServerMessage =
  | { type: "init"; state: AppState }
  | { type: "patch"; entity: Entity; op: "set"; data: unknown }
  | { type: "patch"; entity: Entity; op: "delete"; id: string };

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
  | { type: "tab:purge"; tabId: string }
  | { type: "rename"; entity: "primaryTab" | "group" | "session"; id: string; label: string }
  // Full desired sidebar layout for a tab after a drag. `order` is the flat
  // top-level list of `groupId | sessionId`; `groups` maps each groupId to its
  // ordered child session ids. The server derives groupId/position from this.
  | { type: "layout"; primaryTabId: string; order: string[]; groups: Record<string, string[]> }
  | { type: "note:update"; sessionId: string; content: string };
