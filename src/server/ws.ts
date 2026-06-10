import type { ServerWebSocket } from "bun";
import type { ClientMessage, Entity, ServerMessage } from "../shared/types.ts";
import {
  applyLayout,
  closeSession,
  closeTab,
  createGroup,
  createSession,
  createTab,
  loadState,
  purgeSession,
  purgeTab,
  renameEntity,
  reopenSession,
  reopenTab,
  reorderTabs,
  setTabCwd,
  toggleGroup,
  upsertNote,
} from "./db.ts";
import { config } from "./config.ts";
import { ensure, kill } from "./gotty.ts";
import { attachStatuses, clearStatus, setStatusBroadcaster } from "./status.ts";

// App-level WS connections (distinct from the per-session GoTTY proxy sockets
// that arrive in v0.2). Mutations are persisted first, then broadcast to all.
const pool = new Set<ServerWebSocket<unknown>>();

function send(ws: ServerWebSocket<unknown>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of pool) ws.send(payload);
}

function setPatch(entity: Entity, data: unknown): ServerMessage {
  return { type: "patch", entity, op: "set", data };
}

// Fan an ephemeral attention ping out to every client. Called by the /notify
// route (claude Notification hook). Not persisted — purely a live cue.
export function broadcastNotify(sessionId: string, message: string): void {
  broadcast({ type: "notify", sessionId, message });
}

setStatusBroadcaster((session) => broadcast(setPatch("session", session)));

export function onOpen(ws: ServerWebSocket<unknown>): void {
  pool.add(ws);
  send(ws, {
    type: "init",
    state: attachStatuses(loadState()),
    sessionCommands: config.sessionCommands,
  });
}

export function onClose(ws: ServerWebSocket<unknown>): void {
  pool.delete(ws);
}

export function onMessage(_ws: ServerWebSocket<unknown>, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  switch (msg.type) {
    case "group:create": {
      const { group, order } = createGroup(msg.primaryTabId, msg.label, msg.color);
      broadcast(setPatch("group", group));
      broadcast(setPatch("order", { primaryTabId: msg.primaryTabId, order }));
      break;
    }
    case "group:toggle": {
      const group = toggleGroup(msg.groupId);
      if (group) broadcast(setPatch("group", group));
      break;
    }
    case "session:create": {
      const { session, order } = createSession(
        msg.primaryTabId,
        msg.groupId,
        msg.label,
        msg.id,
        msg.kind ?? "shell",
      );
      void ensure(session.id); // spawn the session's GoTTY shell
      broadcast(setPatch("session", session));
      if (order) broadcast(setPatch("order", { primaryTabId: msg.primaryTabId, order }));
      break;
    }
    case "session:close": {
      const result = closeSession(msg.sessionId);
      if (!result) break;
      kill(msg.sessionId);
      clearStatus(msg.sessionId);
      broadcast(setPatch("session", result.session));
      if (result.order) {
        broadcast(setPatch("order", { primaryTabId: result.primaryTabId, order: result.order }));
      }
      break;
    }
    case "session:reopen": {
      const result = reopenSession(msg.sessionId);
      if (!result) break;
      void ensure(msg.sessionId);
      broadcast(setPatch("session", result.session));
      if (result.order) {
        broadcast(setPatch("order", { primaryTabId: result.primaryTabId, order: result.order }));
      }
      break;
    }
    case "session:purge": {
      const result = purgeSession(msg.sessionId);
      if (!result) break;
      kill(msg.sessionId);
      clearStatus(msg.sessionId);
      broadcast({ type: "patch", entity: "session", op: "delete", id: msg.sessionId });
      if (result.order) {
        broadcast(setPatch("order", { primaryTabId: result.primaryTabId, order: result.order }));
      }
      break;
    }
    case "tab:create": {
      broadcast(setPatch("primaryTab", createTab(msg.label, msg.cwd ?? "", msg.id)));
      break;
    }
    case "tab:reorder": {
      for (const tab of reorderTabs(msg.order)) broadcast(setPatch("primaryTab", tab));
      break;
    }
    case "tab:setCwd": {
      const updated = setTabCwd(msg.tabId, msg.cwd);
      if (updated) broadcast(setPatch("primaryTab", updated));
      break;
    }
    case "tab:close": {
      const result = closeTab(msg.tabId);
      if (!result) break;
      // Stop every shell in the hidden workspace so we don't leak processes.
      for (const sid of result.sessionIds) {
        kill(sid);
        clearStatus(sid);
      }
      broadcast(setPatch("primaryTab", result.tab));
      break;
    }
    case "tab:reopen": {
      const result = reopenTab(msg.tabId);
      if (!result) break;
      // Respawn shells for sessions that were open at the time we hid the tab.
      for (const sid of result.sessionIds) void ensure(sid);
      broadcast(setPatch("primaryTab", result.tab));
      break;
    }
    case "tab:purge": {
      const result = purgeTab(msg.tabId);
      if (!result) break;
      for (const sid of result.sessionIds) {
        kill(sid);
        clearStatus(sid);
        broadcast({ type: "patch", entity: "session", op: "delete", id: sid });
      }
      broadcast({ type: "patch", entity: "primaryTab", op: "delete", id: msg.tabId });
      break;
    }
    case "rename": {
      const updated = renameEntity(msg.entity, msg.id, msg.label);
      if (updated) broadcast(setPatch(msg.entity, updated));
      break;
    }
    case "layout": {
      const { order, sessions } = applyLayout(msg.primaryTabId, msg.order, msg.groups);
      broadcast(setPatch("order", { primaryTabId: msg.primaryTabId, order }));
      for (const session of sessions) broadcast(setPatch("session", session));
      break;
    }
    case "note:update": {
      broadcast(setPatch("note", upsertNote(msg.sessionId, msg.content)));
      break;
    }
  }
}
