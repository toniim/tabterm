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
}

export interface Group {
  id: string;
  primaryTabId: string;
  label: string;
  color: GroupColor;
  isOpen: boolean;
  position: number;
}

export interface Session {
  id: string;
  primaryTabId: string;
  groupId: string | null;
  label: string;
  cwd: string;
  gottyPort: number | null;
  position: number;
}

export interface Note {
  id: string;
  sessionId: string;
  content: string;
  position: number;
  updatedAt: number;
}

// Full application state sent on connect and held in the client store.
// `order` maps a primaryTabId to its flat sidebar order of `groupId | sessionId`.
// AI history is NOT in here — it's fetched per session over REST (see ai.ts).
export interface AppState {
  primaryTabs: Record<string, PrimaryTab>;
  groups: Record<string, Group>;
  sessions: Record<string, Session>;
  order: Record<string, string[]>;
  notes: Record<string, Note>;
}

export type Entity = "primaryTab" | "group" | "session" | "order" | "note";

// AI assistant (REST proxy, not the app WS).
export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiChatRequest {
  sessionId: string;
  message: string;
  scrollback: string[]; // captured from xterm at query time, never stored
}

export interface AiChatResponse {
  reply: string;
}

export interface AiErrorResponse {
  error: string;
}

// Server → Client
export type ServerMessage =
  | { type: "init"; state: AppState }
  | { type: "patch"; entity: Entity; op: "set"; data: unknown }
  | { type: "patch"; entity: Entity; op: "delete"; id: string };

// Client → Server
export type ClientMessage =
  | { type: "session:create"; primaryTabId: string; groupId?: string; label: string }
  | { type: "session:delete"; sessionId: string }
  | { type: "group:create"; primaryTabId: string; label: string; color: GroupColor }
  | { type: "group:toggle"; groupId: string }
  | { type: "rename"; entity: "primaryTab" | "group" | "session"; id: string; label: string }
  // Full desired sidebar layout for a tab after a drag. `order` is the flat
  // top-level list of `groupId | sessionId`; `groups` maps each groupId to its
  // ordered child session ids. The server derives groupId/position from this.
  | { type: "layout"; primaryTabId: string; order: string[]; groups: Record<string, string[]> }
  | { type: "note:create"; sessionId: string }
  | { type: "note:update"; noteId: string; content: string }
  | { type: "note:delete"; noteId: string };
